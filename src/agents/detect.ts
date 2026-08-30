/**
 * Finding the other agent tools on this machine, and deriving how to read them.
 *
 * `jsonl.ts` refuses to ship a scraper per tool, for a good reason: a guess
 * that parses something is worse than no adapter, because it puts a number on
 * the board. That leaves the operator writing `fields` by hand against a format
 * nobody documented, which is the honest option and also the reason most people
 * never turn a second source on.
 *
 * This module is the way out that does not require guessing. It does two things
 * and asserts nothing:
 *
 *   1. **Looks** in the places these tools are commonly installed. A root that
 *      is not there produces "not on this machine", never a claim about where
 *      that tool keeps its files.
 *   2. **Reads one of their actual files** and reports the paths it found. The
 *      field map it suggests is derived from bytes on this disk -- if
 *      `usage.input_tokens` is in the suggestion it is because it was in the
 *      sample, not because this file remembers that Codex uses that name.
 *
 * So the output is a hypothesis you can check in one command against what the
 * tool itself reports, which is the thing the operator can do and this repo
 * cannot.
 *
 * ## Tools that cannot be read at all
 *
 * Two are listed with `unreadable` rather than a root to sample, because the
 * obstacle is the storage format and no amount of field declaration gets past
 * it. Saying so by name is the point: "localflow does not show my Cursor
 * sessions" should have an answer better than silence.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expandHome } from "./jsonl.js";
import type { SourceFields, SourceSpec } from "./jsonl.js";

export interface Candidate {
  id: string;
  label: string;
  /** Roots to try, in order. First one that exists is sampled. */
  roots: string[];
  layout: "jsonl" | "json";
  match?: string;
  /** Set when the tool is findable but its store is not something we can read. */
  unreadable?: string;
}

/**
 * Where to look.
 *
 * Roots are *candidates to try*, not documentation. Several tools honour an
 * environment variable that moves their store, and those are checked first
 * precisely because a hard-coded path would otherwise report "not installed"
 * on the machines that set them.
 */
export function candidates(): Candidate[] {
  const home = homedir();
  const xdg = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  return [
    {
      id: "codex",
      label: "Codex CLI",
      roots: [process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "sessions") : "", join(home, ".codex", "sessions")].filter(Boolean),
      layout: "jsonl",
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      roots: [join(home, ".gemini", "tmp"), join(home, ".gemini")],
      layout: "jsonl",
    },
    {
      id: "opencode",
      label: "opencode",
      // One JSON object per message, in a directory per session. The `json`
      // layout exists for exactly this shape: read line-by-line, a
      // pretty-printed object yields no parseable line and the source reads as
      // present-and-empty.
      roots: [
        process.env.OPENCODE_DATA_DIR ? join(process.env.OPENCODE_DATA_DIR, "storage", "message") : "",
        join(xdg, "opencode", "storage", "message"),
      ].filter(Boolean),
      layout: "json",
    },
    {
      id: "cursor",
      label: "Cursor",
      roots: [
        join(home, ".config", "Cursor", "User", "workspaceStorage"),
        join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
      ],
      layout: "jsonl",
      unreadable:
        "Cursor keeps its conversations in SQLite (state.vscdb, a key/value table of JSON blobs " +
        "with a -wal file alongside it), not in files this adapter can read. Worth knowing before " +
        "you go looking: Cursor stores that database on the machine running its UI even when you " +
        "are working over Remote-SSH, so a remote-watched device would not have it either.",
    },
    {
      id: "aider",
      label: "Aider",
      roots: [],
      layout: "jsonl",
      unreadable:
        "Aider writes its history as Markdown next to the repo it edited (.aider.chat.history.md), " +
        "with no token counts in a form this adapter can total. It reports usage to your terminal " +
        "instead, and that is the number to trust.",
    },
  ];
}

/** Every leaf path in a parsed record, with what kind of value sits there. */
export function leaves(obj: unknown, prefix = "", out: { path: string; kind: string; sample: unknown }[] = [], depth = 0): { path: string; kind: string; sample: unknown }[] {
  if (depth > 6 || obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      leaves(v, path, out, depth + 1);
    } else {
      out.push({ path, kind: Array.isArray(v) ? "array" : typeof v, sample: v });
    }
  }
  return out;
}

/**
 * Match leaf paths against what each field means.
 *
 * Key *names*, not positions -- the one thing that is reasonably stable across
 * tools, because they are all describing the same billing concepts and mostly
 * borrowed the names from the same two APIs. A path only makes it into the
 * suggestion if it exists in the sample and holds the right kind of value, so a
 * tool that names things differently produces a smaller suggestion rather than
 * a wrong one.
 */
const RULES: { field: keyof SourceFields; kinds: string[]; res: RegExp[] }[] = [
  // Two naming conventions, both real. `usage.input_tokens` is the shape the
  // Anthropic and OpenAI APIs use and most CLIs copied; `tokens.input` is the
  // shape a tool uses once it has nested them under their own key. Matching
  // only the first read an opencode store as a session that cost nothing --
  // which is how this second row got here.
  { field: "input", kinds: ["number"], res: [/(^|\.)(input|prompt)_?tokens$/i, /(^|\.)tokens?\.(input|prompt)$/i] },
  { field: "output", kinds: ["number"], res: [/(^|\.)(output|completion)_?tokens$/i, /(^|\.)tokens?\.(output|completion)$/i] },
  {
    field: "cacheRead",
    kinds: ["number"],
    res: [/(cache[_.]?read|cached)_?(input_?)?tokens$/i, /cache\.(read|hit)$/i],
  },
  {
    field: "cacheWrite",
    kinds: ["number"],
    res: [/cache[_.]?(creation|write)_?(input_?)?tokens$/i, /cache\.(write|creation)$/i],
  },
  { field: "model", kinds: ["string"], res: [/(^|\.)model(id|name|_id)?$/i] },
  { field: "messageId", kinds: ["string"], res: [/(^|\.)(message)?_?id$/i] },
  // Numbers allowed: epoch seconds and milliseconds are both common, and the
  // reader already handles either. Requiring a string here dropped the only
  // timestamp opencode writes.
  { field: "timestamp", kinds: ["string", "number"], res: [/(^|\.)(timestamp|created_?at|time|date)$/i, /(^|\.)time\.(created|start)$/i] },
  { field: "title", kinds: ["string"], res: [/(^|\.)(title|summary)$/i] },
  { field: "cwd", kinds: ["string"], res: [/(^|\.)(cwd|directory|workdir)$/i, /(^|\.)path\.(cwd|root)$/i] },
];

export interface Finding {
  id: string;
  label: string;
  /** The root that existed, when one did. */
  root?: string;
  /** Files seen under it. */
  files: number;
  /** The file that was read. */
  sampled?: string;
  /** Fields derived from that file. Only paths actually present. */
  fields: SourceFields;
  /** Every leaf path in the sample, so a name these rules missed is still findable. */
  paths: { path: string; kind: string }[];
  /** Absent, unreadable, or a note about what the sample did not contain. */
  note?: string;
  /** True when there is enough here to write a source that produces priced cards. */
  usable: boolean;
}

function filesUnder(root: string, match: RegExp, cap = 400): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= cap || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= cap) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (match.test(e.name)) found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

/** The newest file, because an old one may predate a format change. */
function newest(paths: string[]): string | undefined {
  let best: { p: string; m: number } | undefined;
  for (const p of paths) {
    try {
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    } catch {
      /* skip */
    }
  }
  return best?.p;
}

/** Read up to `n` records out of a file, whichever layout it is in. */
function sampleRecords(path: string, layout: "jsonl" | "json", n = 40): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  if (layout === "json") {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (rows.length >= n) break;
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a line that does not parse tells us nothing about the shape */
    }
  }
  return rows;
}

export function inspect(c: Candidate): Finding {
  const base: Finding = { id: c.id, label: c.label, files: 0, fields: {}, paths: [], usable: false };

  if (c.unreadable) {
    const root = c.roots.map(expandHome).find((r) => r && existsSync(r));
    return { ...base, root, note: c.unreadable };
  }

  const root = c.roots.map(expandHome).find((r) => r && existsSync(r));
  if (!root) {
    return { ...base, note: `not on this machine — looked in ${c.roots.join(", ") || "no known location"}` };
  }

  const match = new RegExp(c.match ?? (c.layout === "json" ? "\\.json$" : "\\.jsonl$"));
  const files = filesUnder(root, match);
  if (!files.length) {
    return { ...base, root, note: `${root} exists but holds no ${c.layout === "json" ? ".json" : ".jsonl"} files` };
  }

  const sampled = newest(files);
  const rows = sampled ? sampleRecords(sampled, c.layout) : [];
  if (!rows.length) {
    return { ...base, root, files: files.length, sampled, note: "read the newest file and could not parse a record out of it" };
  }

  // Union across records: a token count usually appears on assistant messages
  // only, so the first line of a transcript would suggest nothing at all.
  const seen = new Map<string, string>();
  for (const row of rows) for (const l of leaves(row)) if (!seen.has(l.path)) seen.set(l.path, l.kind);

  const fields: SourceFields = {};
  for (const rule of RULES) {
    // Patterns in order, so the conventional name wins over the fallback when
    // a file happens to carry both.
    for (const re of rule.res) {
      if (fields[rule.field]) break;
      for (const [path, kind] of seen) {
        if (rule.kinds.includes(kind) && re.test(path)) {
          fields[rule.field] = path;
          break;
        }
      }
    }
  }

  const usable = Boolean(fields.input || fields.output);
  return {
    id: c.id,
    label: c.label,
    root,
    files: files.length,
    sampled,
    fields,
    paths: [...seen].map(([path, kind]) => ({ path, kind })),
    usable,
    note: usable
      ? undefined
      : "found records but nothing in them looked like a token count — the cards would show " +
        "activity with no cost. Check the paths listed below and set fields by hand.",
  };
}

export function detect(): Finding[] {
  return candidates().map(inspect);
}

/** The sources.json stanza a finding justifies. Only what was actually seen. */
export function specFor(f: Finding, c: Candidate): SourceSpec | undefined {
  if (!f.root || c.unreadable) return undefined;
  return {
    id: f.id,
    label: f.label,
    root: f.root.replace(homedir(), "~"),
    layout: c.layout,
    ...(c.match ? { match: c.match } : {}),
    fields: f.fields,
  };
}
