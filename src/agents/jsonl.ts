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
  /** Directory holding the tool's session files. `~` is expanded. */
  root: string;
  /** Regex a filename must match. Defaults to `\.jsonl$`. */
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
  const re = new RegExp(spec.match ?? "\\.jsonl$");
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
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, spec.limit ?? 40);
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

/** Read one file into a single card's worth of state. */
export function foldFile(path: string, fields: SourceFields = {}): Folded {
  const out: Folded = {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 },
    lastAt: 0,
    lines: 0,
    unreadable: 0,
    deduped: Boolean(fields.messageId),
  };
  const seen = new Set<string>();

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    out.unreadable = 1;
    return out;
  }

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      out.unreadable++;
      continue;
    }
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

  if (!out.lastAt) {
    try {
      out.lastAt = statSync(path).mtimeMs;
    } catch {
      /* leave at 0 */
    }
  }
  return out;
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

    for (const file of findFiles(this.spec)) {
      const state = foldFile(file.path, fields);
      const id = `${this.id}:${file.path}`;

      if (state.unreadable) {
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
      } else if (!state.deduped && state.lines > 1) {
        degraded.push({
          id,
          reason:
            `source "${this.id}" declares no fields.messageId, so every line was counted. ` +
            "If this tool re-emits usage while a response streams, the totals are inflated.",
        });
      }

      const model = normaliseModel(state.model) ?? state.model;
      const name = file.path.split("/").pop() ?? this.id;
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
        transcriptPath: file.path,
      });
    }

    return { tasks, degraded };
  }
}
