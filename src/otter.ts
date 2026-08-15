/**
 * Optional federation with Otter.
 *
 * [Otter](https://github.com/Unchained-Labs/otter) is the orchestration engine in
 * the Kymatics stack: it queues prompts, runs each in an isolated workspace, and
 * records token usage per job. localflow watches Claude Code sessions on the
 * machine you are sitting at; Otter runs jobs somewhere else. Put both on one
 * board and the question "what is running right now" finally has one answer.
 *
 * This is off unless `LOCALFLOW_OTTER_URL` is set, and a failure to reach Otter
 * degrades the board rather than emptying it — the Claude cards are still real
 * even when the remote is down.
 */
import { costOf, normaliseModel } from "./pricing.js";
import type { Lane, Task, Usage } from "./types.js";

export interface OtterJob {
  id: string;
  status: string;
  prompt?: string;
  project_path?: string;
  created_at?: string;
  updated_at?: string;
}

export interface OtterUsage {
  job_id: string;
  model?: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd?: number | null;
  duration_ms?: number | null;
}

/**
 * Otter's own status vocabulary onto board lanes.
 *
 * `succeeded` maps to `ended`, not to a success lane, for the same reason
 * nothing else here claims success: Otter's own README points out that
 * `status == "succeeded"` only means the process exited zero, and that the gap
 * between that and delivery is "exactly the population of runs that looked fine
 * and shipped nothing".
 */
export function laneForOtter(status: string): Lane {
  switch (status) {
    case "running":
    case "in_progress":
      return "running";
    case "queued":
    case "pending":
    case "scheduled":
      return "queued";
    case "paused":
    case "held":
      return "waiting";
    default:
      return "ended";
  }
}

export interface OtterOptions {
  url?: string;
  timeoutMs?: number;
  asOf?: string;
}

export function otterUrl(opts: OtterOptions = {}): string | undefined {
  const raw = opts.url ?? process.env.LOCALFLOW_OTTER_URL;
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch Otter's queue and history as board cards.
 *
 * Otter reports cost itself when it has a price for the model, and that number
 * is preferred over anything computed here: it was produced by the system that
 * ran the job. Where it is null — Otter's deliberate choice rather than zero —
 * localflow prices the tokens with its own table, and where that fails too the
 * card shows tokens and no dollars.
 */
export async function otterTasks(opts: OtterOptions = {}): Promise<{ tasks: Task[]; error?: string }> {
  const base = otterUrl(opts);
  if (!base) return { tasks: [] };
  const timeout = opts.timeoutMs ?? 5_000;

  let jobs: OtterJob[];
  try {
    const queue = await getJson<OtterJob[] | { jobs?: OtterJob[] }>(`${base}/v1/queue`, timeout);
    jobs = Array.isArray(queue) ? queue : (queue.jobs ?? []);
  } catch (e) {
    return { tasks: [], error: `Otter at ${base} did not answer: ${(e as Error).message}` };
  }

  const tasks: Task[] = [];
  for (const job of jobs) {
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
    let reported: number | null = null;
    let model: string | undefined;
    try {
      const u = await getJson<OtterUsage>(`${base}/v1/jobs/${job.id}/usage`, timeout);
      usage = {
        input: u.prompt_tokens ?? 0,
        output: u.completion_tokens ?? 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        thinking: 0,
      };
      reported = typeof u.estimated_cost_usd === "number" ? u.estimated_cost_usd : null;
      model = normaliseModel(u.model);
    } catch {
      // No usage recorded for this job yet — a 404 here is normal for a queued
      // job and is not worth degrading the whole board over.
    }

    tasks.push({
      id: `otter:${job.id}`,
      source: "otter",
      lane: laneForOtter(job.status),
      outcome: "unknown",
      title: (job.prompt ?? job.id).slice(0, 120),
      name: job.id.slice(0, 8),
      cwd: job.project_path ?? "",
      status: job.status,
      kind: "otter-job",
      model,
      startedAt: job.created_at ? Date.parse(job.created_at) : 0,
      updatedAt: job.updated_at ? Date.parse(job.updated_at) : 0,
      turns: 0,
      queue: [],
      usage,
      costUsd: reported ?? costOf(usage, model, opts.asOf),
      // Otter does not report cache tokens, so this is unknown rather than zero.
      cacheHitRate: null,
      tools: {},
      toolErrors: 0,
      fanouts: [],
    });
  }
  return { tasks };
}
