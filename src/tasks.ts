/**
 * The task lists Claude Code keeps per session.
 *
 * Claude Code writes one JSON file per task under
 * `~/.claude/tasks/<sessionId>/<id>.json`, with `subject`, `description`,
 * `status`, `activeForm`, and the `blocks` / `blockedBy` dependency edges. That
 * is the same list the agent itself works from, so surfacing it on the board
 * closes the gap between "this session is busy" and "busy doing what, and how
 * much is left".
 *
 * Writing is supported and deliberately narrow: create a task, or move one
 * between the three statuses the tool itself uses. There is no delete, because
 * the agent may be mid-run against a list this process does not own, and
 * removing an item under it is the one edit that could make a session act on a
 * task that no longer exists.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { claudeHome } from "./claude.js";
import type { AdapterOptions } from "./claude.js";

export type TaskStatus = "pending" | "in_progress" | "completed";

/** One entry, exactly as Claude Code stores it. */
export interface AgentTask {
  id: string;
  subject: string;
  description?: string;
  /** Present-continuous form, shown while the task is in progress. */
  activeForm?: string;
  status: TaskStatus;
  blocks?: string[];
  blockedBy?: string[];
}

export interface TaskList {
  sessionId: string;
  tasks: AgentTask[];
  /** Files under the session's task directory that would not parse. */
  unreadable: number;
}

const STATUSES: TaskStatus[] = ["pending", "in_progress", "completed"];

export function tasksRoot(opts: AdapterOptions = {}): string {
  return join(claudeHome(opts), "tasks");
}

function sessionDir(sessionId: string, opts: AdapterOptions = {}): string {
  return join(tasksRoot(opts), sessionId);
}

/** Session ids that have a task list on disk. */
export function sessionsWithTasks(opts: AdapterOptions = {}): string[] {
  try {
    return readdirSync(tasksRoot(opts), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Read one session's list.
 *
 * Sorted numerically, not lexically: task 10 comes after task 9, and a board
 * that puts it between 1 and 2 is a board people stop trusting to be in order.
 */
export function readTasks(sessionId: string, opts: AdapterOptions = {}): TaskList {
  const dir = sessionDir(sessionId, opts);
  const out: TaskList = { sessionId, tasks: [], unreadable: 0 };
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as AgentTask;
      if (parsed && typeof parsed.subject === "string") {
        out.tasks.push({ ...parsed, id: parsed.id ?? f.replace(/\.json$/, "") });
      } else {
        out.unreadable++;
      }
    } catch {
      out.unreadable++;
    }
  }
  out.tasks.sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.id.localeCompare(b.id);
  });
  return out;
}

export interface TaskCounts {
  pending: number;
  in_progress: number;
  completed: number;
  total: number;
}

export function countTasks(list: TaskList): TaskCounts {
  const counts: TaskCounts = { pending: 0, in_progress: 0, completed: 0, total: list.tasks.length };
  for (const t of list.tasks) {
    if (t.status === "pending" || t.status === "in_progress" || t.status === "completed") {
      counts[t.status]++;
    }
  }
  return counts;
}

/**
 * The next free id.
 *
 * Ids are allocated as `max + 1` rather than `count + 1` so that a list with a
 * gap in it — because a task was removed by hand, or because two sessions share
 * a directory — cannot mint an id that already exists and silently overwrite a
 * task somebody is working on.
 */
export function nextId(list: TaskList): string {
  let max = 0;
  for (const t of list.tasks) {
    const n = Number(t.id);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return String(max + 1);
}

export interface CreateTaskRequest {
  sessionId: string;
  subject: string;
  description?: string;
  activeForm?: string;
}

export interface TaskWriteResult {
  ok: boolean;
  detail: string;
  task?: AgentTask;
}

export function createTask(req: CreateTaskRequest, opts: AdapterOptions = {}): TaskWriteResult {
  const subject = req.subject?.trim();
  if (!subject) return { ok: false, detail: "a task needs a subject" };
  if (subject.length > 500) return { ok: false, detail: "subject is longer than 500 characters" };
  if (!/^[A-Za-z0-9._-]+$/.test(req.sessionId ?? "")) {
    // The session id becomes a path segment. Anything that could contain a
    // separator is refused here rather than sanitised, because a "cleaned"
    // id that still resolves somewhere is the bug this is preventing.
    return { ok: false, detail: "that is not a session id" };
  }

  const dir = sessionDir(req.sessionId, opts);
  const existing = readTasks(req.sessionId, opts);
  const task: AgentTask = {
    id: nextId(existing),
    subject,
    description: req.description?.trim() || subject,
    activeForm: req.activeForm?.trim() || undefined,
    status: "pending",
    blocks: [],
    blockedBy: [],
  };

  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${task.id}.json`);
    if (existsSync(path)) {
      return { ok: false, detail: `task ${task.id} already exists — the list changed under us` };
    }
    writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  } catch (e) {
    return { ok: false, detail: `could not write the task: ${(e as Error).message}` };
  }
  return { ok: true, detail: `created task ${task.id}`, task };
}

export function setTaskStatus(
  sessionId: string,
  taskId: string,
  status: TaskStatus,
  opts: AdapterOptions = {},
): TaskWriteResult {
  if (!STATUSES.includes(status)) {
    return { ok: false, detail: `status must be one of ${STATUSES.join(", ")}` };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
    return { ok: false, detail: "that is not a session id and task id" };
  }
  const path = join(sessionDir(sessionId, opts), `${taskId}.json`);
  if (!existsSync(path)) return { ok: false, detail: `no task ${taskId} in session ${sessionId}` };
  try {
    const task = JSON.parse(readFileSync(path, "utf8")) as AgentTask;
    // Read-modify-write of the whole object, so fields this version does not
    // know about survive. A future Claude Code field must not be deleted by a
    // status change made from here.
    task.status = status;
    writeFileSync(path, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    return { ok: true, detail: `task ${taskId} is now ${status}`, task };
  } catch (e) {
    return { ok: false, detail: `could not update the task: ${(e as Error).message}` };
  }
}
