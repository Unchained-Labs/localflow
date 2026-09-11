/**
 * The archive: every job this machine ever ran, kept after the evidence is gone.
 *
 * The board is derived, not stored. Every poll re-reads the live registry and
 * re-parses the transcripts, which is what makes it cheap and what makes it
 * forgetful — three separate ways:
 *
 *   * **Ended cards age off the board.** `--history N` keeps the last N, because
 *     a board that is also an archive is neither.
 *   * **Transcripts expire.** Claude Code prunes `~/.claude/projects` on its own
 *     schedule (30 days, by default). The board does not lose old sessions
 *     because it chose to — it loses them because the file it was reading is
 *     deleted underneath it.
 *   * **Workflow runs were never written down at all.** They lived in a Map in
 *     the server process and died with it.
 *
 * So this module is the one part of localflow that *keeps* something. It is an
 * append-only JSONL ledger under `~/.localflow/history/`, one file per calendar
 * month, written as sessions are observed rather than reconstructed afterwards —
 * because by the time you want last quarter's numbers, the transcripts that
 * would prove them are gone.
 *
 * Four rules, all of which cost something and all of which are deliberate:
 *
 *   * **Append, never rewrite.** A session is observed hundreds of times across
 *     its life. Updating a row in place needs a database and a write lock;
 *     appending a new row and folding on read needs neither, and a process
 *     killed mid-write corrupts at most the last line instead of the file. The
 *     cost is that the ledger holds many rows per session. That is what the
 *     change-signature below is for.
 *   * **No runtime dependencies.** This package has none, on purpose — it is
 *     published, and a native SQLite build is a thing that breaks on someone
 *     else's machine at install time. JSONL is also the format localflow already
 *     reads, so the archive stays greppable with the same tools as everything
 *     else here.
 *   * **The newest observation of a session wins, by the session's clock.**
 *     Not by file order. A backfill run in September writes August sessions
 *     after September ones, and last-line-wins would let the backfill overwrite
 *     fresher data with staler. Folding on `updatedAt` makes the ledger
 *     order-independent, which means backfill can be re-run safely.
 *   * **Coverage travels with every answer.** `burn.ts` refuses to state a rate
 *     over a sample it does not have, and the archive does not get to pretend
 *     otherwise: a query whose window starts before the first row here is
 *     answered with a floor and says so. An archive that silently reports
 *     "$0 in March" because it was not running in March is worse than no
 *     archive at all.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { totalTokens } from "./types.js";
import type { Lane, Outcome, Task, Usage } from "./types.js";
import type { RunState } from "./workflow.js";

/** One observation of one session. Everything a card showed, minus what only the transcript can answer. */
export interface SessionRecord {
  type: "session";
  /** When this row was appended. Distinct from `updatedAt`, which is the session's own clock. */
  at: number;
  id: string;
  source: string;
  device?: string;
  title: string;
  name: string;
  cwd: string;
  branch?: string;
  model?: string;
  lane: Lane;
  outcome: Outcome;
  status: string;
  kind: string;
  startedAt: number;
  updatedAt: number;
  turns: number;
  usage: Usage;
  costUsd: number | null;
  tools: Record<string, number>;
  toolErrors: number;
  /**
   * How many fan-outs the session did, not what they were. The shape of a
   * fan-out is only meaningful next to the transcript that explains it, and
   * that is exactly the thing this archive expects to outlive.
   */
  fanouts: number;
  /** Where the transcript was when this was written. It may well be gone now. */
  transcriptPath?: string;
  /**
   * Set to "mtime" when the session's own clock was unreadable and the
   * file's modification time stood in for it.
   *
   * A transcript that parses to no timestamps — truncated, or a format this
   * reader does not know — otherwise lands the session on 1970-01-01, where it
   * sorts below everything forever and drags no window with it. The mtime is
   * weaker evidence than the transcript, so it is labelled rather than
   * silently mixed in with the real thing.
   */
  timeFrom?: "mtime";
}

/** One workflow run, recorded when it reaches a terminal state. */
export interface RunRecord {
  type: "run";
  at: number;
  id: string;
  workflow: string;
  startedAt: number;
  endedAt?: number;
  state: RunState["state"];
  detail: string;
  costUsd: number | null;
  /** Per-node outcome, flattened: enough to say what failed without the live object. */
  nodes: { id: string; state: string; sessionId?: string; costUsd: number | null }[];
}

export type HistoryRecord = SessionRecord | RunRecord;

export interface Coverage {
  /** Earliest activity any row describes, or null when the archive is empty. */
  from: number | null;
  /** Latest activity any row describes. */
  to: number | null;
  /** Ledger files read. */
  files: number;
  /** Rows read, before folding. */
  rows: number;
  /**
   * Ledger files skipped because they cannot contain anything in the window.
   *
   * A row written in March describes work that happened at or before March —
   * nothing observes the future — so a query for the last 7 days never has to
   * open March. This is what keeps a years-deep archive from being read into
   * memory to answer a question about this week.
   */
  skipped: number;
  /** Rows that would not parse. A truncated final line after a hard kill lands here. */
  unreadable: number;
  /**
   * When the archive itself begins, from the oldest ledger file on disk —
   * regardless of which files this query needed to open.
   *
   * Separate from `from`, which is the oldest activity actually read. Without
   * it, a windowed query that skipped the old files would report the archive
   * as starting last Tuesday and call a perfectly answerable question partial.
   */
  archiveFrom: number | null;
}

export interface HistoryQuery {
  /** Only jobs active at or after this epoch-ms. */
  since?: number;
  until?: number;
  /** Substring match on cwd. The cheap form of "which project". */
  project?: string;
  source?: string;
  /** Newest first, capped. Absent means everything. */
  limit?: number;
}

export interface HistoryResult {
  /** The page: newest first, cut to `limit`. */
  sessions: SessionRecord[];
  runs: RunRecord[];
  /**
   * Totals over everything the filters matched, NOT over the page above.
   *
   * A limit is a display cap, not a filter: `?limit=3` asking what this
   * machine has spent must not answer with what three sessions spent. The
   * page is cut; the arithmetic is not.
   */
  totals: HistoryTotals;
  /** How many matched before the limit, so a caller can tell it is looking at a page. */
  matched: { sessions: number; runs: number };
  coverage: Coverage;
  /**
   * True when the requested window starts before the archive does, so the
   * totals are a floor rather than a total. Set for the caller to *say*, not
   * to silently correct.
   */
  partial: boolean;
}

export function historyDir(home?: string): string {
  return join(home ?? process.env.LOCALFLOW_HOME ?? join(homedir(), ".localflow"), "history");
}

/** One file per calendar month, named by when the row was written. */
function ledgerFile(dir: string, at: number): string {
  const d = new Date(at);
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return join(dir, `${month}.jsonl`);
}

/**
 * What has to change before a session is worth another row.
 *
 * Without this the ledger grows by one row per session per poll — at a 3-second
 * poll that is 28,800 rows a day describing a machine where nothing happened.
 * With it, a session appends when it actually moves and is silent otherwise, so
 * the file tracks work rather than uptime.
 */
function signature(t: Task): string {
  return [t.lane, t.turns, totalTokens(t.usage), t.status, t.toolErrors, t.costUsd ?? "?"].join("|");
}

function toRecord(t: Task, at: number): SessionRecord {
  return {
    type: "session",
    at,
    id: t.id,
    source: t.source,
    device: t.device,
    title: t.title,
    name: t.name,
    cwd: t.cwd,
    branch: t.branch,
    model: t.model,
    lane: t.lane,
    outcome: t.outcome,
    status: t.status,
    kind: t.kind,
    startedAt: t.startedAt,
    updatedAt: t.updatedAt,
    turns: t.turns,
    usage: { ...t.usage },
    costUsd: t.costUsd,
    tools: { ...t.tools },
    toolErrors: t.toolErrors,
    fanouts: t.fanouts.length,
    transcriptPath: t.transcriptPath,
  };
}

export function runRecord(r: RunState, at: number): RunRecord {
  return {
    type: "run",
    at,
    id: r.id,
    workflow: r.workflow,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    state: r.state,
    detail: r.detail,
    costUsd: r.costUsd,
    nodes: (r.nodes ?? []).map((n) => ({
      id: n.id,
      state: String(n.state),
      sessionId: n.sessionId,
      costUsd: n.costUsd ?? null,
    })),
  };
}

/**
 * The write side.
 *
 * Holds the last signature per session so a poll that changed nothing writes
 * nothing. The map is in-memory and starts empty, so the first poll after a
 * restart re-anchors every visible session with a fresh row — which is the
 * behaviour you want, since a restart is exactly when the ledger might have
 * missed something.
 */
export class Archive {
  private readonly dir: string;
  private readonly seen = new Map<string, string>();
  /** Set once a write fails, so a read-only or full disk degrades instead of throwing every poll. */
  private broken: string | null = null;

  constructor(home?: string) {
    this.dir = historyDir(home);
  }

  get path(): string {
    return this.dir;
  }

  /** Null unless writing has failed, in which case it is why — for `degraded`. */
  get error(): string | null {
    return this.broken;
  }

  /**
   * Append whichever of these tasks have moved since last time.
   *
   * `datedFromFile` names the ids whose timestamps came from the filesystem
   * rather than from the transcript, so the row can say so. Only backfill
   * passes it; a live card always has the registry's clock.
   */
  record(tasks: Task[], now = Date.now(), datedFromFile?: Set<string>): number {
    const rows: string[] = [];
    for (const t of tasks) {
      const sig = signature(t);
      if (this.seen.get(t.id) === sig) continue;
      this.seen.set(t.id, sig);
      const rec = toRecord(t, now);
      if (datedFromFile?.has(t.id)) rec.timeFrom = "mtime";
      rows.push(JSON.stringify(rec));
    }
    return this.append(rows, now);
  }

  /** Append a workflow run. Called on terminal states, where the row is the whole point. */
  recordRun(run: RunState, now = Date.now()): number {
    return this.append([JSON.stringify(runRecord(run, now))], now);
  }

  private append(rows: string[], now: number): number {
    if (!rows.length) return 0;
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(ledgerFile(this.dir, now), `${rows.join("\n")}\n`);
      this.broken = null;
      return rows.length;
    } catch (e) {
      // A board that stops rendering because the archive disk filled up has
      // traded the thing that works for the thing that records it.
      this.broken = `history archive not writable at ${this.dir}: ${(e as Error).message}`;
      return 0;
    }
  }
}

/**
 * The read side: fold every ledger file into one row per session and one per run.
 *
 * Sessions fold on `updatedAt` rather than file order, so re-running a backfill
 * cannot replace fresh data with stale. Runs fold on `at`, because a run row is
 * only ever written once it is terminal and a later row for the same id means a
 * correction.
 */
export function readHistory(q: HistoryQuery = {}, home?: string): HistoryResult {
  const dir = historyDir(home);
  const coverage: Coverage = { from: null, to: null, files: 0, rows: 0, skipped: 0, unreadable: 0, archiveFrom: null };
  const sessions = new Map<string, SessionRecord>();
  const runs = new Map<string, RunRecord>();

  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    // No archive yet is not an error. It is a machine that has not run one.
    return {
      sessions: [],
      runs: [],
      totals: historyTotals({ sessions: [], runs: [] }),
      matched: { sessions: 0, runs: 0 },
      coverage,
      partial: q.since !== undefined,
    };
  }

  // Filenames are YYYY-MM and rows are filed by write time, so the last
  // instant a file could describe is the end of its own month.
  for (const f of files) {
    const m = /^(\d{4})-(\d{2})\.jsonl$/.exec(f);
    if (m) {
      const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
      coverage.archiveFrom = coverage.archiveFrom === null ? start : Math.min(coverage.archiveFrom, start);
      const endOfMonth = Date.UTC(Number(m[1]), Number(m[2]), 1) - 1;
      if (q.since !== undefined && endOfMonth < q.since) {
        coverage.skipped++;
        continue;
      }
    }

    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    coverage.files++;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      coverage.rows++;
      let rec: HistoryRecord;
      try {
        rec = JSON.parse(line) as HistoryRecord;
      } catch {
        coverage.unreadable++;
        continue;
      }
      if (rec.type === "session") {
        const prev = sessions.get(rec.id);
        if (!prev || rec.updatedAt > prev.updatedAt || (rec.updatedAt === prev.updatedAt && rec.at >= prev.at)) {
          sessions.set(rec.id, rec);
        }
        span(coverage, rec.startedAt, rec.updatedAt);
      } else if (rec.type === "run") {
        const prev = runs.get(rec.id);
        if (!prev || rec.at >= prev.at) runs.set(rec.id, rec);
        span(coverage, rec.startedAt, rec.endedAt ?? rec.at);
      } else {
        coverage.unreadable++;
      }
    }
  }

  let s = [...sessions.values()];
  let r = [...runs.values()];

  if (q.since !== undefined) {
    s = s.filter((x) => x.updatedAt >= q.since!);
    r = r.filter((x) => (x.endedAt ?? x.startedAt) >= q.since!);
  }
  if (q.until !== undefined) {
    s = s.filter((x) => x.startedAt <= q.until!);
    r = r.filter((x) => x.startedAt <= q.until!);
  }
  if (q.project) {
    const needle = q.project.toLowerCase();
    s = s.filter((x) => x.cwd.toLowerCase().includes(needle));
    r = r.filter((x) => x.workflow.toLowerCase().includes(needle));
  }
  if (q.source) {
    s = s.filter((x) => x.source === q.source);
  }

  s.sort((a, b) => b.updatedAt - a.updatedAt);
  r.sort((a, b) => b.startedAt - a.startedAt);

  // Before the cut, deliberately. See HistoryResult.totals.
  const totals = historyTotals({ sessions: s, runs: r });
  const matched = { sessions: s.length, runs: r.length };

  if (q.limit !== undefined && q.limit >= 0) {
    s = s.slice(0, q.limit);
    r = r.slice(0, q.limit);
  }

  // The honest-floor flag: asked about a window the archive does not reach back into.
  // How far back the archive demonstrably reaches: the oldest ledger file on
  // disk, or older still if a backfill wrote older activity into a newer file.
  // Measured against that rather than against what this query happened to read —
  // skipping March to answer about this week does not make the answer a floor.
  const reach =
    coverage.archiveFrom === null
      ? coverage.from
      : coverage.from === null
        ? coverage.archiveFrom
        : Math.min(coverage.archiveFrom, coverage.from);
  const partial = q.since !== undefined && (reach === null || q.since < reach);
  return { sessions: s, runs: r, totals, matched, coverage, partial };
}

function span(c: Coverage, from: number, to: number): void {
  if (Number.isFinite(from) && from > 0) c.from = c.from === null ? from : Math.min(c.from, from);
  if (Number.isFinite(to) && to > 0) c.to = c.to === null ? to : Math.max(c.to, to);
}

export interface HistoryTotals {
  sessions: number;
  runs: number;
  turns: number;
  tokens: number;
  /** Null when nothing in the set could be priced. Never zero — that reads as free. */
  costUsd: number | null;
  unpriced: number;
  projects: number;
}

/** Totals over a set of records. Separate from `summarise` because that one is about lanes, not time. */
export function historyTotals(r: Pick<HistoryResult, "sessions" | "runs">): HistoryTotals {
  let turns = 0;
  let tokens = 0;
  let costUsd: number | null = null;
  let unpriced = 0;
  const projects = new Set<string>();
  for (const s of r.sessions) {
    turns += s.turns;
    tokens += totalTokens(s.usage);
    projects.add(s.cwd);
    if (s.costUsd === null) unpriced++;
    else costUsd = (costUsd ?? 0) + s.costUsd;
  }
  for (const run of r.runs) {
    if (run.costUsd !== null) costUsd = (costUsd ?? 0) + run.costUsd;
  }
  return { sessions: r.sessions.length, runs: r.runs.length, turns, tokens, costUsd, unpriced, projects: projects.size };
}

/* ---------------------------------------------------------------------------
 * backfill
 * ------------------------------------------------------------------------- */

export interface BackfillResult {
  /** Transcripts walked. */
  scanned: number;
  /** Rows appended — sessions the archive did not already hold at this freshness. */
  written: number;
  /** Already present and no staler. Re-running a backfill should be mostly this. */
  skipped: number;
  /** Transcripts that would not parse into a card at all. */
  failed: number;
  /** Sessions timestamped from the file rather than from their own contents. */
  dated: number;
}

/**
 * Seed the archive from the transcripts still on disk.
 *
 * The archive only knows what it watched, so on a machine that has been working
 * for months it starts empty while `~/.claude/projects` still holds the last few
 * weeks of real history. This reads that tree once and folds it in, so "every
 * job it ever did" does not quietly mean "every job since you turned this on".
 *
 * It is idempotent by construction: rows fold on `updatedAt`, so a second run
 * over unchanged transcripts writes nothing. That matters because the honest
 * time to run it is "whenever you suspect a gap", which means often.
 *
 * What it cannot recover is anything Claude Code already deleted. Run it once
 * early; it is the only chance at the window between the first session and the
 * day the archive was switched on.
 */
export async function backfill(
  opts: { home?: string } & Record<string, unknown> = {},
): Promise<BackfillResult> {
  const { TranscriptCache, endedSessionIds, toTask } = await import("./claude.js");
  const out: BackfillResult = { scanned: 0, written: 0, skipped: 0, failed: 0, dated: 0 };

  // Everything on disk, live or not: passing no live sessions means nothing is
  // excluded, and an uncapped limit means a year of history is a year of rows.
  const found = endedSessionIds([], opts as never, Number.MAX_SAFE_INTEGER);
  if (!found.length) return out;

  const existing = readHistory({}, opts.home as string | undefined);
  const known = new Map(existing.sessions.map((s) => [s.id, s.updatedAt]));

  const cache = new TranscriptCache();
  const archive = new Archive(opts.home as string | undefined);
  const now = Date.now();
  const rows: Task[] = [];
  const mtimeDated = new Set<string>();

  for (const f of found) {
    out.scanned++;
    let task: Task;
    try {
      const state = cache.refresh(f.id, f.path);
      task = toTask(f.id, undefined, state, f.path, opts as never);
    } catch {
      out.failed++;
      continue;
    }
    cache.forget(f.id);

    // Fall back to the file clock when the transcript has no clock of its own.
    if (!task.updatedAt || !task.startedAt) {
      task = {
        ...task,
        startedAt: task.startedAt || f.mtime,
        updatedAt: task.updatedAt || f.mtime,
      };
      mtimeDated.add(f.id);
    }

    const seenAt = known.get(f.id);
    if (seenAt !== undefined && seenAt >= task.updatedAt) {
      out.skipped++;
      continue;
    }
    rows.push(task);
  }

  out.written = archive.record(rows, now, mtimeDated);
  out.dated = mtimeDated.size;
  return out;
}

/* ---------------------------------------------------------------------------
 * pruning
 * ------------------------------------------------------------------------- */

export interface PruneResult {
  /** Ledger files this would remove, oldest first. */
  remove: { file: string; bytes: number }[];
  /** Files kept. */
  keep: string[];
  bytes: number;
  /** False when nothing was deleted because the caller did not confirm. */
  applied: boolean;
}

/**
 * Drop whole months off the back of the archive.
 *
 * A row costs about 650 bytes and one is written every time a session moves, so
 * a heavily-used month lands somewhere in the tens of megabytes. That is not a
 * problem until it is, and on a machine with a disk ceiling it eventually is —
 * so there is a way out that is not "delete the directory and lose everything".
 *
 * Monthly files are what make this trivial: a month is the unit, so pruning
 * never has to rewrite a file and can never corrupt one. It is also why this
 * cannot trim *within* a month — asking for that back would mean a rewrite, and
 * a rewrite of an append-only log is how append-only logs get lost.
 *
 * `apply` defaults to false. Deleting history is the one operation here with no
 * undo, and a command that did it merely for being run is a command nobody
 * dares try.
 */
export function pruneHistory(keepMonths: number, opts: { apply?: boolean; home?: string } = {}): PruneResult {
  const dir = historyDir(opts.home);
  const result: PruneResult = { remove: [], keep: [], bytes: 0, applied: false };
  if (!Number.isFinite(keepMonths) || keepMonths < 1) return result;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return result;
  }

  const cut = Math.max(0, files.length - keepMonths);
  result.keep = files.slice(cut);
  for (const f of files.slice(0, cut)) {
    let bytes = 0;
    try {
      bytes = statSync(join(dir, f)).size;
    } catch {
      /* a file that vanished is already pruned */
    }
    result.remove.push({ file: f, bytes });
    result.bytes += bytes;
  }

  if (opts.apply) {
    for (const r of result.remove) {
      try {
        unlinkSync(join(dir, r.file));
      } catch {
        /* nothing to do about a file we cannot delete except not claim we did */
      }
    }
    result.applied = true;
  }
  return result;
}
