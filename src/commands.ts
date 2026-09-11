/**
 * What a workflow step can be, besides a sentence.
 *
 * A prompt sent to `claude -p` can be a slash command (`/review`), a skill
 * (`/pdf`), or plain text, and a run can be handed to a named subagent with
 * `--agent`. Claude Code keeps the definitions of all three as Markdown files
 * with YAML frontmatter, in a handful of well-known places:
 *
 *   ~/.claude/commands/<ns>/<name>.md       user commands, invoked as /name
 *   <project>/.claude/commands/<name>.md    project commands
 *   ~/.claude/skills/<name>/SKILL.md        user skills, also invoked as /name
 *   <project>/.claude/skills/<name>/SKILL.md
 *   ~/.claude/agents/<name>.md              subagent types, used with --agent
 *   <project>/.claude/agents/<name>.md
 *   ~/.claude/plugins/**                    the same three shapes, from plugins
 *
 * This module reads those and nothing else. It does not list the CLI's built-in
 * commands, because nothing on disk says which ones exist in the installed
 * version — a list typed from memory would offer `/foo` on a machine whose CLI
 * has never heard of it, and the palette would then be a guess wearing a
 * catalogue's clothes. Anything not listed can still be typed by hand.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { claudeHome } from "./claude.js";
import type { AdapterOptions } from "./claude.js";

export type CatalogueKind = "command" | "skill" | "agent";
export type CatalogueScope = "user" | "project" | "plugin";

export interface CatalogueItem {
  kind: CatalogueKind;
  /** Bare name: `review`, `pdf`, `code-reviewer`. */
  name: string;
  /** What goes in a prompt (`/review`) or after `--agent` (`code-reviewer`). */
  invoke: string;
  /** The frontmatter description, or the first line of the body. */
  description: string;
  scope: CatalogueScope;
  /** Where it was read from. Shown so a surprising entry can be checked. */
  path: string;
  /** Subdirectory a command sat in, which Claude Code shows as its namespace. */
  namespace?: string;
  argumentHint?: string;
  /** A model the definition itself pins. */
  model?: string;
}

export interface Catalogue {
  commands: CatalogueItem[];
  skills: CatalogueItem[];
  agents: CatalogueItem[];
  /** Directories that were looked in, whether or not anything was found. */
  scanned: string[];
  /** Files that would not read. Named rather than dropped. */
  unreadable: string[];
}

export interface CatalogueOptions extends AdapterOptions {
  /** A project whose `.claude/` should be included. */
  cwd?: string;
}

/* ---------------------------------------------------------------------------
 * frontmatter
 * ------------------------------------------------------------------------- */

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * The `---` block at the top of a definition file.
 *
 * Deliberately a flat `key: value` reader rather than a YAML parser: every
 * field these files use is a scalar, a runtime dependency is a thing this
 * package does not have, and a value this cannot read is simply not offered
 * rather than misread.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const fields: Record<string, string> = {};
  if (!text.startsWith("---")) return { fields, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fields, body: text };
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  for (const raw of head.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fields[m[1]!] = v;
  }
  return { fields, body };
}

function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t.length > 200 ? `${t.slice(0, 197)}…` : t;
  }
  return "";
}

/* ---------------------------------------------------------------------------
 * scanning
 * ------------------------------------------------------------------------- */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Every `*.md` under `root`, depth-limited, with the path relative to it. */
function markdownUnder(root: string, maxDepth: number): { path: string; rel: string }[] {
  const out: { path: string; rel: string }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push({ path: p, rel: relative(root, p) });
      }
    }
  };
  walk(root, 0);
  return out;
}

function readItem(
  kind: CatalogueKind,
  scope: CatalogueScope,
  path: string,
  name: string,
  namespace: string | undefined,
  unreadable: string[],
): CatalogueItem | null {
  if (!NAME_RE.test(name)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    unreadable.push(path);
    return null;
  }
  const { fields, body } = parseFrontmatter(text);
  const finalName = kind === "command" ? name : fields.name && NAME_RE.test(fields.name) ? fields.name : name;
  return {
    kind,
    name: finalName,
    invoke: kind === "agent" ? finalName : `/${finalName}`,
    description: fields.description || firstLine(body),
    scope,
    path,
    namespace,
    argumentHint: fields["argument-hint"] || undefined,
    model: fields.model || undefined,
  };
}

/** `commands/`: one file per command, subdirectories are namespaces. */
function scanCommands(root: string, scope: CatalogueScope, into: Catalogue): void {
  if (!isDir(root)) return;
  into.scanned.push(root);
  for (const { path, rel } of markdownUnder(root, 3)) {
    const ns = dirname(rel);
    const item = readItem("command", scope, path, basename(rel, ".md"), ns === "." ? undefined : ns, into.unreadable);
    if (item) into.commands.push(item);
  }
}

/** `skills/`: one directory per skill, holding SKILL.md. Nested layouts are searched. */
function scanSkills(root: string, scope: CatalogueScope, into: Catalogue): void {
  if (!isDir(root)) return;
  into.scanned.push(root);
  for (const { path } of markdownUnder(root, 4)) {
    if (basename(path) !== "SKILL.md") continue;
    const item = readItem("skill", scope, path, basename(dirname(path)), undefined, into.unreadable);
    if (item) into.skills.push(item);
  }
}

/** `agents/`: one file per subagent type. */
function scanAgents(root: string, scope: CatalogueScope, into: Catalogue): void {
  if (!isDir(root)) return;
  into.scanned.push(root);
  for (const { path, rel } of markdownUnder(root, 1)) {
    const item = readItem("agent", scope, path, basename(rel, ".md"), undefined, into.unreadable);
    if (item) into.agents.push(item);
  }
}

/**
 * Plugins: a tree of unknown depth in which the same three directory names
 * mean the same three things. Found by name, at a bounded depth, so a plugin
 * cache the size of a node_modules cannot make the palette take a second to
 * open.
 */
function scanPlugins(root: string, into: Catalogue): void {
  if (!isDir(root)) return;
  into.scanned.push(root);
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.name === "commands") scanCommands(p, "plugin", into);
      else if (e.name === "skills") scanSkills(p, "plugin", into);
      else if (e.name === "agents") scanAgents(p, "plugin", into);
      else if (depth < 6) walk(p, depth + 1);
    }
  };
  walk(root, 0);
}

/**
 * Everything invocable, from the places Claude Code reads.
 *
 * Project definitions shadow user ones of the same name, which is the CLI's
 * own precedence. Plugin entries never shadow anything: they are listed after
 * both, so a plugin that happens to ship a `/review` sits beside yours rather
 * than replacing it in the palette.
 */
export function listCatalogue(opts: CatalogueOptions = {}): Catalogue {
  const home = claudeHome(opts);
  const out: Catalogue = { commands: [], skills: [], agents: [], scanned: [], unreadable: [] };

  scanCommands(join(home, "commands"), "user", out);
  scanSkills(join(home, "skills"), "user", out);
  scanAgents(join(home, "agents"), "user", out);

  if (opts.cwd && existsSync(opts.cwd)) {
    const proj = join(opts.cwd, ".claude");
    scanCommands(join(proj, "commands"), "project", out);
    scanSkills(join(proj, "skills"), "project", out);
    scanAgents(join(proj, "agents"), "project", out);
  }

  scanPlugins(join(home, "plugins"), out);

  out.commands = dedupe(out.commands);
  out.skills = dedupe(out.skills);
  out.agents = dedupe(out.agents);
  return out;
}

const RANK: Record<CatalogueScope, number> = { project: 0, user: 1, plugin: 2 };

function dedupe(items: CatalogueItem[]): CatalogueItem[] {
  const local = new Map<string, CatalogueItem>();
  const plugin: CatalogueItem[] = [];
  for (const it of items) {
    if (it.scope === "plugin") {
      plugin.push(it);
      continue;
    }
    const key = it.namespace ? `${it.namespace}/${it.name}` : it.name;
    const prev = local.get(key);
    if (!prev || RANK[it.scope] < RANK[prev.scope]) local.set(key, it);
  }
  return [...local.values(), ...plugin].sort(
    (a, b) => a.name.localeCompare(b.name) || RANK[a.scope] - RANK[b.scope],
  );
}
