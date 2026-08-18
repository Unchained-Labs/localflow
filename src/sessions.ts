/**
 * Every session, not just the ones on the board.
 *
 * The board caps history on purpose — a machine with a year of Claude Code
 * behind it should not open onto a scrollable archive. But "show me everything
 * I have ever run" is a different question with a different answer, and it was
 * unanswerable: `Board.poll()` takes a `history` limit and the UI never offered
 * a way past it.
 *
 * This is that answer. It walks the transcript tree and the live registry and
 * returns one row per session ever recorded, cheaply: filenames and stat() only,
 * no parsing. A row here tells you a session existed, where, and when it last
 * moved. Open one and the board's own reader fills in what it cost.
 *
 * Two sources, because neither is complete on its own. `~/.claude/projects` has
 * every session that ever wrote a transcript, including ones whose process is
 * long gone. `~/.claude/sessions/<pid>.json` has the live registry, including
 * sessions too new to have flushed a transcript yet.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { claudeHome } from "./claude.js";
import type { AdapterOptions } from "./claude.js";
import type { LiveSession } from "./types.js";

export interface SessionRow {
  sessionId: string;
  /** Directory the session ran in, as far as it can be recovered. */
  cwd: string;
  /** Claude Code's slug for that directory — the on-disk project folder. */
  project: string;
  transcriptPath?: string;
  bytes: number;
  updatedAt: number;
  live: boolean;
  pid?: number;
  status?: string;
  name?: string;
}

export interface SessionArchive {
  rows: SessionRow[];
  /** Rows the caller did not receive, because `limit` cut them off. */
  truncated: number;
  total: number;
  /** Directories that could not be read. Reported rather than skipped. */
  unreadable: string[];
}

/**
 * Recover a working directory from Claude Code's project slug.
 *
 * The slug replaces every non-alphanumeric character with `-`, which is lossy:
 * `/home/w/dev/my-app` and `/home/w/dev/my.app` slug identically. So this
 * returns a *plausible* path, and the field is named `cwd` rather than
 * `path` — the authoritative directory is the one in the live registry, and
 * this is only used for sessions that have already ended.
 */
export function unslug(project: string): string {
  return project.startsWith("-") ? `/${project.slice(1).replace(/-/g, "/")}` : project;
}

/** The live registry, read from disk rather than from the CLI. */
export function registryRows(opts: AdapterOptions = {}): LiveSession[] {
  const dir = join(claudeHome(opts), "sessions");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows: LiveSession[] = [];
  for (const f of files) {
    try {
      const row = JSON.parse(readFileSync(join(dir, f), "utf8")) as LiveSession;
      if (row && typeof row.sessionId === "string") rows.push(row);
    } catch {
      /* a half-written registry file is transient; the next poll gets it */
    }
  }
  return rows;
}

export interface ArchiveOptions extends AdapterOptions {
  /** Rows to return, newest first. 0 means all of them. */
  limit?: number;
  /** Substring match against session id, cwd, or project. */
  query?: string;
}

export function listSessions(opts: ArchiveOptions = {}): SessionArchive {
  const root = join(claudeHome(opts), "projects");
  const unreadable: string[] = [];
  const byId = new Map<string, SessionRow>();

  let projects: string[];
  try {
    projects = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    projects = [];
    unreadable.push(root);
  }

  for (const project of projects) {
    const dir = join(root, project);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      unreadable.push(dir);
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const sessionId = f.slice(0, -".jsonl".length);
      const existing = byId.get(sessionId);
      // A session resumed from another directory has a transcript in each. The
      // most recently touched one is the one that reflects where it actually is.
      if (existing && existing.updatedAt >= st.mtimeMs) continue;
      byId.set(sessionId, {
        sessionId,
        project,
        cwd: unslug(project),
        transcriptPath: path,
        bytes: st.size,
        updatedAt: st.mtimeMs,
        live: false,
      });
    }
  }

  for (const live of registryRows(opts)) {
    const row = byId.get(live.sessionId);
    if (row) {
      Object.assign(row, {
        live: true,
        pid: live.pid,
        status: live.status,
        name: live.name,
        // The registry knows the real directory; the slug was only a guess.
        cwd: live.cwd || row.cwd,
      });
    } else {
      byId.set(live.sessionId, {
        sessionId: live.sessionId,
        project: "",
        cwd: live.cwd,
        bytes: 0,
        updatedAt: live.startedAt ?? Date.now(),
        live: true,
        pid: live.pid,
        status: live.status,
        name: live.name,
      });
    }
  }

  let rows = [...byId.values()];
  const q = opts.query?.trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) =>
        r.sessionId.toLowerCase().includes(q) ||
        r.cwd.toLowerCase().includes(q) ||
        (r.name ?? "").toLowerCase().includes(q),
    );
  }
  // Live first, then most recently touched: the session that just asked you a
  // question should not be below one that ended in March.
  rows.sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt);

  const total = rows.length;
  const limit = opts.limit ?? 0;
  const page = limit > 0 ? rows.slice(0, limit) : rows;
  return { rows: page, truncated: total - page.length, total, unreadable };
}
