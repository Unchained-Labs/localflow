/**
 * The adapter for every tool this repo cannot verify itself.
 *
 * Claude Code's on-disk format is in here because it is on this machine and can
 * be read, tested against fixtures, and corrected when it drifts. Codex CLI's
 * is not. Neither is Gemini CLI's, or Aider's, or OpenCode's. Writing five
 * scrapers against formats nobody here has ever seen would produce five files
 * that look like support and are actually guesses — and a guess that parses
 * something is worse than no adapter, because it puts a number on the board.
 *
 * So instead of guessing the shape, this adapter is *told* it. You point it at
 * the files a tool writes and name the JSON keys that hold the model and the
 * token counts, and it produces cards. Anyone with the tool installed can wire
 * it up in a few minutes and check the result against what the tool itself
 * reports — which is a thing they can do and this repo cannot.
 *
 * ~/.localflow/sources.json:
 *
 *   {
 *     "sources": [
 *       {
 *         "id": "codex",
 *         "label": "Codex CLI",
 *         "root": "~/.codex/sessions",
 *         "match": "\\.jsonl$",
 *         "fields": {
 *           "model":     "model",
 *           "input":     "usage.input_tokens",
 *           "output":    "usage.output_tokens",
 *           "cacheRead": "usage.cached_tokens",
 *           "messageId": "id",
 *           "timestamp": "created_at",
 *           "title":     "title",
 *           "cwd":       "cwd"
 *         }
 *       }
 *     ]
 *   }
 *
 * Every field is optional except `root`. A source that names no token fields
 * still produces cards — with zero usage and `costUsd: null`, which says "this
 * ran, and we do not know what it cost". That is a useful card. A card with an
 * invented cost is not.
 *
 * `messageId` matters more than it looks: the same usage object is often
 * re-emitted as a response streams, and summing every line inflates the total.
 * Name a field that is stable per message and each one is counted once. Leave
 * it out and every line counts — correct for tools that write one line per
 * completed call, wrong for tools that stream, and the card says which
 * assumption it made.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { costOf, normaliseModel } from "../pricing.js";
import type { Lane, Task, Usage } from "../types.js";
import { PRESENT, absent, broken } from "./types.js";
import type { AdapterContext, AdapterResult, AgentAdapter, Probe } from "./types.js";

export interface SourceFields {
  model?: string;
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheWrite?: string;
  messageId?: string;
  timestamp?: string;
  title?: string;
  cwd?: string;
}

export interface SourceSpec {
  id: string;
  label?: string;
  /**
   * How the tool lays its records out on disk.
   *
   * `jsonl` (the default) is one record per line, one file per session --
   * Claude Code, Codex and Gemini all do this.
   *
   * `json` is one record per *file*, with the session being the directory they
   * sit in. opencode writes
   * `storage/message/<sessionID>/msg_<messageID>.json` that way, and reading it
   * line-by-line finds nothing at all: a pretty-printed object has no line that
   * parses on its own, so the source probes present, reads its files, and
   * produces a card with zero of everything. Silently. That is the exact
   * failure mode this whole file exists to avoid, so the layout is declared
   * rather than sniffed.
   */
  layout?: "jsonl" | "json";
  /**
   * A colour for this source's badge, if you want one.
   *
   * Deliberately yours rather than ours: see `identity.ts` for the measurement,
   * but the short version is that a hue per tool stops being distinguishable
   * past three tools, and you know how many you actually run.
   */
  color?: string;
  /** Directory holding the tool's session files. `~` is expanded. */
  root: string;
  /** Regex a filename must match. Defaults to `\.jsonl$`, or `\.json$` under the json layout. */
  match?: string;
  /** Recurse into subdirectories. Most tools nest by project. */
  recursive?: boolean;
  fields?: SourceFields;
  /** Files older than this many days are ignored. Default 30. */
  maxAgeDays?: number;
  /** Cap on files read per poll, newest first. Default 40. */
  limit?: number;
}

export interface SourcesFile {
  sources: SourceSpec[];
}

export function sourcesPath(): string {
  return process.env.LOCALFLOW_SOURCES ?? join(homedir(), ".localflow", "sources.json");
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Read the declared sources. A missing file is the normal case, not an error. */
export function loadSources(path = sourcesPath()): { sources: SourceSpec[]; error?: string } {
  if (!existsSync(path)) return { sources: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SourcesFile;
    const list = Array.isArray(parsed?.sources) ? parsed.sources : [];
    const good = list.filter((s) => s && typeof s.id === "string" && typeof s.root === "string");
    const dropped = list.length - good.length;
    return {
      sources: good,
      error: dropped ? `${path}: ignored ${dropped} source(s) with no id or root` : undefined,
    };
  } catch (e) {
    return { sources: [], error: `${path} is not valid JSON: ${(e as Error).message}` };
  }
}

/** Follow a dotted path into a parsed object. Returns undefined rather than throwing. */
export function dig(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Newest-first list of candidate files under a root. */
export function findFiles(spec: SourceSpec): { path: string; mtime: number }[] {
  const root = expandHome(spec.root);
  const re = new RegExp(spec.match ?? (spec.layout === "json" ? "\\.json$" : "\\.jsonl$"));
  const maxAge = (spec.maxAgeDays ?? 30) * 86_400_000;
  const cutoff = Date.now() - maxAge;
  const found: { path: string; mtime: number }[] = [];

  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // Bounded because a mis-specified root ("~") must not walk a home
        // directory. Six levels covers every per-project layout seen so far.
        if (spec.recursive !== false && depth < 6) walk(full, depth + 1);
        continue;
      }
      if (!re.test(e.name)) continue;
      try {
        const st = statSync(full);
        if (st.mtimeMs >= cutoff) found.push({ path: full, mtime: st.mtimeMs });
      } catch {
        /* vanished between readdir and stat — not an error worth raising */
      }
    }
  };

  walk(root, 0);
  const sorted = found.sort((a, b) => b.mtime - a.mtime);
  // Under the json layout the cap belongs to `findGroups`, which knows how many
  // files make up one session. Capping here would hand it 40 files that might
  // be two sessions, and the board would show two cards for a machine with
  // thirty.
  return spec.layout === "json" ? sorted : sorted.slice(0, spec.limit ?? 40);
}

/**
 * One card's worth of files.
 *
 * Under `jsonl` a file is a session. Under `json` a *directory* is a session and
 * the files in it are its messages, which is how opencode stores things: one
 * `msg_<id>.json` per message under `storage/message/<sessionID>/`.
 */
export interface SourceGroup {
  /** Stable within this source. The file or directory the card came from. */
  key: string;
  files: string[];
  mtime: number;
}

export function findGroups(spec: SourceSpec): SourceGroup[] {
  const files = findFiles(spec);
  const limit = spec.limit ?? 40;

  if (spec.layout !== "json") {
    return files.map((f) => ({ key: f.path, files: [f.path], mtime: f.mtime }));
  }

  const byDir = new Map<string, SourceGroup>();
  for (const f of files) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/")) || f.path;
    const g = byDir.get(dir);
    if (g) {
      g.files.push(f.path);
      g.mtime = Math.max(g.mtime, f.mtime);
    } else {
      byDir.set(dir, { key: dir, files: [f.path], mtime: f.mtime });
    }
  }
  return [...byDir.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

interface Folded {
  usage: Usage;
  model?: string;
  title?: string;
  cwd?: string;
  lastAt: number;
  lines: number;
  unreadable: number;
  /** True when a messageId field was named and used to de-duplicate. */
  deduped: boolean;
}

function emptyFold(fields: SourceFields): Folded {
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 },
    lastAt: 0,
    lines: 0,
    unreadable: 0,
    deduped: Boolean(fields.messageId),
  };
}

/**
 * Every record in one file.
 *
 * `jsonl` yields one per line. `json` yields exactly one -- the whole file --
 * and a file that does not parse counts as one unreadable record rather than
 * as nothing, so a directory of malformed messages reads as broken instead of
 * as empty.
 */
function recordsIn(path: string, layout: SourceSpec["layout"]): { rows: unknown[]; unreadable: number } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { rows: [], unreadable: 1 };
  }

  if (layout === "json") {
    try {
      return { rows: [JSON.parse(text)], unreadable: 0 };
    } catch {
      return { rows: [], unreadable: 1 };
    }
  }

  const rows: unknown[] = [];
  let unreadable = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      rows.push(JSON.parse(raw));
    } catch {
      unreadable++;
    }
  }
  return { rows, unreadable };
}

/** Read one session's files into a single card's worth of state. */
export function foldGroup(
  paths: string[],
  fields: SourceFields = {},
  layout: SourceSpec["layout"] = "jsonl",
): Folded {
  const out = emptyFold(fields);
  const seen = new Set<string>();

  // Oldest first, so `??=` below takes the *first* model and title a session
  // saw rather than whichever file the directory listing happened to return
  // first. A session's opening message is the one that named it.
  const ordered = [...paths].sort();

  for (const path of ordered) {
  const { rows, unreadable } = recordsIn(path, layout);
  out.unreadable += unreadable;
  for (const row of rows) {
    out.lines++;

    out.model ??= str(dig(row, fields.model));
    out.title ??= str(dig(row, fields.title));
    out.cwd ??= str(dig(row, fields.cwd));

    const at = dig(row, fields.timestamp);
    const ms = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : Date.parse(String(at ?? ""));
    if (Number.isFinite(ms)) out.lastAt = Math.max(out.lastAt, ms);

    if (fields.messageId) {
      const id = str(dig(row, fields.messageId));
      // A line with no id is counted: skipping it would silently drop usage,
      // which is the failure this de-duplication exists to prevent.
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
    }

    out.usage.input += num(dig(row, fields.input));
    out.usage.output += num(dig(row, fields.output));
    out.usage.cacheRead += num(dig(row, fields.cacheRead));
    // No TTL split is available from a generic source, so writes land on the
    // 5-minute tier — the cheaper of the two. A cost derived this way is a
    // floor, not an estimate, and undershooting is the safer direction.
    out.usage.cacheWrite5m += num(dig(row, fields.cacheWrite));
  }
  }

  if (!out.lastAt) {
    for (const path of ordered) {
      try {
        out.lastAt = Math.max(out.lastAt, statSync(path).mtimeMs);
      } catch {
        /* leave it */
      }
    }
  }
  return out;
}

/** One file, for a source that keeps one session per file. */
export function foldFile(path: string, fields: SourceFields = {}): Folded {
  return foldGroup([path], fields, "jsonl");
}

/**
 * A card from a declared source.
 *
 * Every one lands in the `ended` lane. These files are what a tool left behind;
 * nothing in them says a session is still running, and a board that guessed
 * "running" from a recent mtime would show a finished job as live for however
 * long its lane rule happened to be.
 */
export class DeclaredSourceAdapter implements AgentAdapter {
  readonly id: string;
  readonly label: string;

  constructor(private readonly spec: SourceSpec) {
    this.id = spec.id;
    this.label = spec.label ?? spec.id;
  }

  async probe(): Promise<Probe> {
    const root = expandHome(this.spec.root);
    if (!existsSync(root)) {
      return absent(`${this.label}: nothing at ${root} — the tool is not on this machine`);
    }
    try {
      statSync(root);
    } catch (e) {
      return broken(`${this.label}: cannot read ${root}: ${(e as Error).message}`);
    }
    return PRESENT;
  }

  async poll(ctx: AdapterContext): Promise<AdapterResult> {
    const tasks: Task[] = [];
    const degraded: AdapterResult["degraded"] = [];
    const fields = this.spec.fields ?? {};
    const priced = Boolean(fields.input || fields.output);

    for (const group of findGroups(this.spec)) {
      const state = foldGroup(group.files, fields, this.spec.layout);
      const id = `${this.id}:${group.key}`;

      if (state.unreadable && state.lines) {
        degraded.push({
          id,
          reason: `${state.unreadable} line(s) would not parse and were skipped`,
        });
      }
      if (!priced) {
        degraded.push({
          id,
          reason:
            `no token fields declared for source "${this.id}" — this card shows activity but ` +
            "no usage and no cost. Add fields.input / fields.output in sources.json.",
        });
      } else if (!state.deduped && state.lines > 1 && this.spec.layout !== "json") {
        degraded.push({
          id,
          reason:
            `source "${this.id}" declares no fields.messageId, so every line was counted. ` +
            "If this tool re-emits usage while a response streams, the totals are inflated.",
        });
      }

      // Nothing parsed at all. This must never render as a session that ran
      // and cost nothing, and the message has to name the likely fix rather
      // than the symptom: reading a pretty-printed file line by line fails on
      // *every* line, so "6 lines would not parse" is exactly what someone
      // sees the first time they point a jsonl source at a json store, and it
      // tells them nothing about what to do.
      if (!state.lines) {
        degraded.push({
          id,
          reason:
            this.spec.layout === "json"
              ? state.unreadable
                // The files are there and matched. They are broken, and saying
                // "check your root" would send someone to fix a setting that is
                // already right.
                ? `${state.unreadable} file(s) under "${this.id}" would not parse as JSON`
                : `${group.files.length} file(s) under "${this.id}" held no readable record — check the root and the file pattern`
              : `nothing in ${group.key} parsed as one record per line. If "${this.id}" writes ` +
                'one pretty-printed JSON object per file, declare "layout": "json" for it.',
        });
      }

      const model = normaliseModel(state.model) ?? state.model;
      const name = group.key.split("/").pop() ?? this.id;
      tasks.push({
        id,
        source: this.id,
        lane: "ended" as Lane,
        outcome: "unknown",
        title: state.title ?? name.replace(/\.[^.]+$/, ""),
        name: name.slice(0, 24),
        cwd: state.cwd ?? "",
        status: "ended",
        kind: this.label,
        model,
        startedAt: state.lastAt,
        updatedAt: state.lastAt,
        turns: 0,
        queue: [],
        usage: state.usage,
        costUsd: costOf(state.usage, model, ctx.asOf),
        // A generic source rarely distinguishes cached from uncached input, and
        // a hit rate computed from zeros would read as 0% rather than unknown.
        cacheHitRate: state.usage.cacheRead ? state.usage.cacheRead / (state.usage.cacheRead + state.usage.input || 1) : null,
        tools: {},
        toolErrors: 0,
        fanouts: [],
        transcriptPath: group.files.length === 1 ? group.files[0] : group.key,
      });
    }

    return { tasks, degraded };
  }
}
