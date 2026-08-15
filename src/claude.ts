/**
 * The Claude Code adapter.
 *
 * Everything localflow knows about what is running comes from two places, both
 * of them on your own disk:
 *
 *   1. `claude agents --json` — the live session registry. This is a supported,
 *      TTY-free, machine-readable command, which is why it is used in preference
 *      to reading `~/.claude/sessions/*.json` directly even though that file is
 *      where the same data lives. A published contract can be relied on; a file
 *      layout found by poking around cannot.
 *   2. The transcript for each session, for everything the registry does not
 *      carry: what the session is *called*, what it is spending, what it is
 *      doing right now.
 *
 * Nothing here talks to the network, and nothing here reads a session it was not
 * asked about.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { costOf, normaliseModel } from "./pricing.js";
import { advance, cacheHitRate, emptyState } from "./transcript.js";
import type { Lane, LiveSession, Outcome, Task, TranscriptState } from "./types.js";

const run = promisify(execFile);

export interface AdapterOptions {
  /** Root of the Claude Code state directory. Overridable for tests. */
  home?: string;
  /** The `claude` binary. Overridable for tests and for non-standard installs. */
  bin?: string;
  /** Date used for intro-price expiry. Defaults to today. */
  asOf?: string;
}

export function claudeHome(opts: AdapterOptions = {}): string {
  return opts.home ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/**
 * The live session list.
 *
 * A failure here is reported, never swallowed into an empty board: "no sessions"
 * and "we could not ask" look identical on a Kanban and mean opposite things.
 */
export async function liveSessions(opts: AdapterOptions = {}): Promise<LiveSession[]> {
  const bin = opts.bin ?? process.env.LOCALFLOW_CLAUDE_BIN ?? "claude";
  const { stdout } = await run(bin, ["agents", "--json"], {
    maxBuffer: 8 << 20,
    timeout: 20_000,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("`claude agents --json` did not return an array");
  return parsed.filter(isLiveSession);
}

function isLiveSession(v: unknown): v is LiveSession {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o.sessionId === "string" && typeof o.cwd === "string";
}

/**
 * Claude Code slugs a working directory into a project folder name by replacing
 * every character outside `[A-Za-z0-9]` with `-`, so `/home/w/dev/x` becomes
 * `-home-w-dev-x`. Derived from the layout on disk and cross-checked against
 * every project directory in `test/fixtures`.
 */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Locate a session's transcript.
 *
 * The slug is tried first because it is O(1). A session can be resumed from a
 * different directory than it started in, though, so the fallback is a scan —
 * still cheap, since it only stats filenames.
 */
export function findTranscript(sessionId: string, cwd: string, opts: AdapterOptions = {}): string | undefined {
  const root = join(claudeHome(opts), "projects");
  const direct = join(root, slugForCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;

  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Which lane a session belongs in.
 *
 * The mapping is deliberately dull, because every interesting version of it
 * involves guessing. `busy` means the model is working. `idle` with prompts
 * waiting means the queue has not drained yet. `idle` with an empty queue means
 * it is waiting on *you* — which is the single most useful thing this board
 * shows, since a session blocked on a question is invisible from the terminal
 * you are not looking at.
 */
export function laneFor(session: LiveSession | undefined, state: TranscriptState | undefined): Lane {
  if (!session) return "ended";
  if (session.status === "busy") return "running";
  if ((state?.queue.length ?? 0) > 0) return "queued";
  return "waiting";
}

/**
 * What can be said about how a session finished.
 *
 * Only two values, and neither is "succeeded". A transcript records that tools
 * returned errors; it does not record whether the session did what it was asked.
 * Rendering "done" as "went well" would be inventing the fact the user most
 * wants — the same defect authsweep calls a false clean, wearing a green tick.
 */
export function outcomeFor(state: TranscriptState | undefined): Outcome {
  return (state?.toolErrors ?? 0) > 0 ? "errors-seen" : "unknown";
}

/** Title, in descending order of how much it tells you. */
export function titleFor(state: TranscriptState | undefined, session: LiveSession | undefined, id: string): string {
  const ai = state?.title?.trim();
  if (ai) return ai;
  const prompt = state?.lastPrompt?.trim().replace(/\s+/g, " ");
  if (prompt) return prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt;
  return session?.name ?? id.slice(0, 8);
}

/**
 * Holds one `TranscriptState` per session across polls, so a 17MB transcript is
 * parsed once and then only appended to.
 */
export class TranscriptCache {
  private readonly states = new Map<string, TranscriptState>();

  get(sessionId: string): TranscriptState | undefined {
    return this.states.get(sessionId);
  }

  /** Parse whatever is new. Returns undefined when there is no readable transcript. */
  refresh(sessionId: string, path: string | undefined): TranscriptState | undefined {
    if (!path) return this.states.get(sessionId);
    let state = this.states.get(sessionId);
    if (!state) {
      state = emptyState(sessionId);
      this.states.set(sessionId, state);
    }
    advance(path, state);
    return state;
  }

  forget(sessionId: string): void {
    this.states.delete(sessionId);
  }

  get size(): number {
    return this.states.size;
  }
}

/** Assemble one board card from the registry row and the transcript. */
export function toTask(
  id: string,
  session: LiveSession | undefined,
  state: TranscriptState | undefined,
  transcriptPath: string | undefined,
  opts: AdapterOptions = {},
): Task {
  const usage = state?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
  // Transcripts report the dated id (`claude-haiku-4-5-20251001`); the price
  // table is keyed on the undated one. Without this every haiku and dated-opus
  // session shows "cost unknown", which reads as "free".
  const model = state?.model;
  const priceable = normaliseModel(model);
  return {
    id,
    source: "claude",
    lane: laneFor(session, state),
    outcome: outcomeFor(state),
    title: titleFor(state, session, id),
    name: session?.name ?? id.slice(0, 8),
    cwd: session?.cwd ?? state?.cwd ?? "",
    branch: state?.gitBranch,
    status: session?.status ?? "ended",
    kind: session?.kind ?? "interactive",
    pid: session?.pid,
    model,
    effort: state?.effort,
    startedAt: session?.startedAt ?? state?.lastActivityAt ?? 0,
    updatedAt: state?.lastActivityAt ?? session?.startedAt ?? 0,
    turns: state?.turns ?? 0,
    lastPrompt: state?.lastPrompt,
    lastToolName: state?.lastToolName,
    queue: state?.queue ?? [],
    usage,
    costUsd: costOf(usage, priceable, opts.asOf),
    cacheHitRate: cacheHitRate(usage),
    tools: state?.tools ?? {},
    toolErrors: state?.toolErrors ?? 0,
    fanouts: state?.fanouts ?? [],
    transcriptPath,
    transcriptMissing: transcriptPath === undefined ? true : undefined,
  };
}

/** Transcripts on disk that the registry no longer lists — the ended sessions. */
export function endedSessionIds(live: LiveSession[], opts: AdapterOptions = {}, limit = 40): { id: string; path: string; mtime: number }[] {
  const root = join(claudeHome(opts), "projects");
  const liveIds = new Set(live.map((s) => s.sessionId));
  const found: { id: string; path: string; mtime: number }[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(root, d)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const id = f.slice(0, -".jsonl".length);
      if (liveIds.has(id)) continue;
      const p = join(root, d, f);
      try {
        found.push({ id, path: p, mtime: statSync(p).mtimeMs });
      } catch {
        /* a file that vanished between readdir and stat is not an error worth raising */
      }
    }
  }
  // Most recent first, capped: a machine with a year of history should not turn
  // the board into a scrollable archive.
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}
