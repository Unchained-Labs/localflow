/**
 * The numbers behind the plots.
 *
 * Everything here is derived from cards the board already produced — no extra
 * reads, no second source of truth. That matters because a metrics view that
 * computes its own totals will eventually disagree with the cards above it, and
 * the first time it does, both become unreadable.
 *
 * Two rules the series obey:
 *
 * **Unpriced sessions are excluded from money, not counted as zero.** A model
 * with no known rate contributes nothing to a spend series and is reported
 * separately as `unpricedSessions`. Folding it in as 0 would draw a flat line
 * through a period that actually cost something.
 *
 * **Buckets that no session landed in are still emitted.** A day with no work
 * is a real day at zero, and dropping it makes a gap look like a plateau.
 */
import { cacheWriteTotal } from "./types.js";
import type { BoardSummary, Lane, Task, Usage } from "./types.js";

export interface Bucket {
  /** Start of the bucket, epoch ms. */
  at: number;
  sessions: number;
  usage: Usage;
  costUsd: number;
  /** Sessions in this bucket whose model has no known price. */
  unpriced: number;
}

export interface Slice {
  key: string;
  sessions: number;
  usage: Usage;
  /** Null when nothing in the slice could be priced. */
  costUsd: number | null;
  unpriced: number;
}

export interface Metrics {
  generatedAt: number;
  /** Activity over time, oldest bucket first. */
  buckets: Bucket[];
  bucketMs: number;
  byModel: Slice[];
  bySource: Slice[];
  byCwd: Slice[];
  lanes: Record<Lane, number>;
  totals: {
    sessions: number;
    usage: Usage;
    costUsd: number | null;
    unpricedSessions: number;
    cacheHitRate: number | null;
    toolErrors: number;
    toolCalls: number;
  };
  /** Fan-out widths observed, for the parallelism histogram. */
  fanoutWidths: { width: number; count: number; failed: number }[];
  /** Most-used tools, descending. */
  tools: { name: string; calls: number }[];
}

function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
}

function addUsage(into: Usage, from: Usage): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite5m += from.cacheWrite5m;
  into.cacheWrite1h += from.cacheWrite1h;
  into.thinking += from.thinking;
}

/**
 * Bucket width from the span being plotted.
 *
 * Fixed-width buckets look wrong at both ends: hourly over a year is 8760 bars
 * nobody can read, daily over an afternoon is one. Each threshold is set so the
 * widest span that reaches it still yields at most ~60 buckets — the point past
 * which bars stop being distinguishable at any sane chart width.
 *
 * The arithmetic is worth writing down, because getting it wrong is invisible
 * (the chart still renders, just with 120 hairlines in it):
 *
 *     6h  / 15min = 24     24h / 1h  = 24     7d  / 6h  = 28
 *     60d / 1d    = 60     365d / 7d = 52     beyond that, months
 */
export function bucketWidth(spanMs: number): number {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (spanMs <= 6 * HOUR) return 15 * MINUTE;
  if (spanMs <= DAY) return HOUR;
  if (spanMs <= 7 * DAY) return 6 * HOUR;
  if (spanMs <= 60 * DAY) return DAY;
  if (spanMs <= 365 * DAY) return 7 * DAY;
  // Past a year there is no fixed width that holds: a monthly bucket is fine
  // over two years and 100 bars over eight. So the last tier is proportional —
  // whole days wide, chosen to land at ~52 buckets whatever the span. A ladder
  // of constants can always be walked off the end of; this one cannot.
  return Math.max(30, Math.ceil(spanMs / (52 * DAY))) * DAY;
}

function slice(tasks: Task[], keyOf: (t: Task) => string): Slice[] {
  const map = new Map<string, Slice>();
  for (const t of tasks) {
    const key = keyOf(t) || "unknown";
    let s = map.get(key);
    if (!s) {
      s = { key, sessions: 0, usage: zeroUsage(), costUsd: null, unpriced: 0 };
      map.set(key, s);
    }
    s.sessions++;
    addUsage(s.usage, t.usage);
    if (t.costUsd === null) s.unpriced++;
    else s.costUsd = (s.costUsd ?? 0) + t.costUsd;
  }
  // By spend where it is known, then by tokens — so a slice full of unpriced
  // models still sorts sensibly instead of sinking to the bottom.
  return [...map.values()].sort(
    (a, b) =>
      (b.costUsd ?? 0) - (a.costUsd ?? 0) ||
      b.usage.output + b.usage.input - (a.usage.output + a.usage.input),
  );
}

export function computeMetrics(board: BoardSummary, now = Date.now()): Metrics {
  const tasks = board.tasks;
  const stamps = tasks.map((t) => t.updatedAt || t.startedAt).filter((n) => n > 0);
  const first = stamps.length ? Math.min(...stamps) : now;
  const last = stamps.length ? Math.max(...stamps, now) : now;
  const bucketMs = bucketWidth(Math.max(last - first, 60_000));

  const buckets = new Map<number, Bucket>();
  const start = Math.floor(first / bucketMs) * bucketMs;
  const end = Math.floor(last / bucketMs) * bucketMs;
  // Pre-seed every bucket in range, capped so a single very old session cannot
  // ask for a million empty points.
  for (let at = start; at <= end && buckets.size < 2000; at += bucketMs) {
    buckets.set(at, { at, sessions: 0, usage: zeroUsage(), costUsd: 0, unpriced: 0 });
  }

  const totals = {
    sessions: tasks.length,
    usage: zeroUsage(),
    costUsd: null as number | null,
    unpricedSessions: 0,
    cacheHitRate: null as number | null,
    toolErrors: 0,
    toolCalls: 0,
  };
  const toolCounts = new Map<string, number>();
  const fanouts = new Map<number, { count: number; failed: number }>();

  for (const t of tasks) {
    addUsage(totals.usage, t.usage);
    if (t.costUsd === null) totals.unpricedSessions++;
    else totals.costUsd = (totals.costUsd ?? 0) + t.costUsd;
    totals.toolErrors += t.toolErrors;
    for (const [name, n] of Object.entries(t.tools ?? {})) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + n);
      totals.toolCalls += n;
    }
    for (const f of t.fanouts ?? []) {
      const cur = fanouts.get(f.width) ?? { count: 0, failed: 0 };
      cur.count++;
      cur.failed += f.failed;
      fanouts.set(f.width, cur);
    }

    const at = Math.floor((t.updatedAt || t.startedAt || now) / bucketMs) * bucketMs;
    const bucket = buckets.get(at);
    if (bucket) {
      bucket.sessions++;
      addUsage(bucket.usage, t.usage);
      if (t.costUsd === null) bucket.unpriced++;
      else bucket.costUsd += t.costUsd;
    }
  }

  const cachedIn = totals.usage.cacheRead;
  const allIn = cachedIn + totals.usage.input + cacheWriteTotal(totals.usage);
  totals.cacheHitRate = allIn > 0 ? cachedIn / allIn : null;

  return {
    generatedAt: now,
    bucketMs,
    buckets: [...buckets.values()].sort((a, b) => a.at - b.at),
    byModel: slice(tasks, (t) => t.model ?? "no model recorded"),
    bySource: slice(tasks, (t) => t.source),
    byCwd: slice(tasks, (t) => t.cwd.split("/").slice(-2).join("/")),
    lanes: board.lanes,
    totals,
    fanoutWidths: [...fanouts.entries()]
      .map(([width, v]) => ({ width, ...v }))
      .sort((a, b) => a.width - b.width),
    tools: [...toolCounts.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 12),
  };
}
