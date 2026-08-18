/**
 * The metrics, and the two ways a chart can lie.
 *
 * Both rules under test here are about omission rather than arithmetic: a
 * bucket that nothing landed in must still exist, and a session nobody could
 * price must not be counted as costing nothing. Get either wrong and the chart
 * is still drawable, still plausible, and wrong in a direction the reader
 * cannot see.
 */
import { describe, expect, it } from "vitest";

import { bucketWidth, computeMetrics } from "../src/metrics.js";
import { summarise } from "../src/board.js";
import type { Task, Usage } from "../src/types.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function usage(over: Partial<Usage> = {}): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0, ...over };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t",
    source: "claude",
    lane: "ended",
    outcome: "unknown",
    title: "t",
    name: "t",
    cwd: "/home/w/dev/app",
    status: "ended",
    kind: "interactive",
    startedAt: 0,
    updatedAt: 0,
    turns: 1,
    queue: [],
    usage: usage(),
    costUsd: null,
    cacheHitRate: null,
    tools: {},
    toolErrors: 0,
    fanouts: [],
    ...over,
  };
}

describe("bucketWidth", () => {
  it("never asks for more bars than a chart can show", () => {
    // The upper bound is the one that matters: overshooting it renders a chart
    // of hairlines that looks fine in code review and is unreadable on screen.
    for (const span of [HOUR, 5 * HOUR, DAY, 3 * DAY, 10 * DAY, 45 * DAY, 90 * DAY, 400 * DAY, 3000 * DAY]) {
      const buckets = span / bucketWidth(span);
      expect(buckets, `span ${span / DAY}d`).toBeGreaterThanOrEqual(3);
      expect(buckets, `span ${span / DAY}d`).toBeLessThanOrEqual(60);
    }
  });
});

describe("computeMetrics", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");

  it("emits empty buckets rather than closing the gap", () => {
    // Two sessions a day apart. Every bucket between them is real and empty,
    // and dropping them would draw a straight line through a quiet day.
    const board = summarise([
      task({ id: "a", updatedAt: now - DAY, usage: usage({ output: 10 }), costUsd: 1 }),
      task({ id: "b", updatedAt: now, usage: usage({ output: 10 }), costUsd: 1 }),
    ]);
    const m = computeMetrics(board, now);
    expect(m.buckets.length).toBeGreaterThan(2);
    expect(m.buckets.some((b) => b.sessions === 0)).toBe(true);
    expect(m.buckets.reduce((n, b) => n + b.sessions, 0)).toBe(2);
  });

  it("excludes unpriced sessions from spend and counts them separately", () => {
    const board = summarise([
      task({ id: "a", updatedAt: now, costUsd: 4 }),
      task({ id: "b", updatedAt: now, costUsd: null }),
    ]);
    const m = computeMetrics(board, now);
    expect(m.totals.costUsd).toBe(4);
    expect(m.totals.unpricedSessions).toBe(1);
    // The bucket carries the same distinction, so the bar can hatch it.
    const bucket = m.buckets.find((b) => b.sessions === 2);
    expect(bucket?.costUsd).toBe(4);
    expect(bucket?.unpriced).toBe(1);
  });

  it("reports a slice as cost-unknown rather than zero when nothing in it is priced", () => {
    const board = summarise([
      task({ id: "a", model: "mystery-1", updatedAt: now, costUsd: null }),
      task({ id: "b", model: "mystery-1", updatedAt: now, costUsd: null }),
    ]);
    const m = computeMetrics(board, now);
    const slice = m.byModel.find((s) => s.key === "mystery-1");
    expect(slice?.costUsd).toBeNull();
    expect(slice?.unpriced).toBe(2);
  });

  it("groups by tool, so a mixed board separates its sources", () => {
    const board = summarise([
      task({ id: "a", source: "claude", updatedAt: now }),
      task({ id: "b", source: "codex", updatedAt: now }),
      task({ id: "c", source: "codex", updatedAt: now }),
    ]);
    const m = computeMetrics(board, now);
    expect(m.bySource.map((s) => [s.key, s.sessions]).sort()).toEqual([
      ["claude", 1],
      ["codex", 2],
    ]);
  });

  it("reports cache hit rate as unknown rather than 0% when nothing was read", () => {
    const board = summarise([task({ id: "a", updatedAt: now, usage: usage() })]);
    expect(computeMetrics(board, now).totals.cacheHitRate).toBeNull();
  });

  it("counts a fan-out histogram from observed widths", () => {
    const board = summarise([
      task({
        id: "a",
        updatedAt: now,
        fanouts: [
          { messageId: "m1", at: now, width: 3, children: [], failed: 1 },
          { messageId: "m2", at: now, width: 3, children: [], failed: 0 },
          { messageId: "m3", at: now, width: 1, children: [], failed: 0 },
        ],
      }),
    ]);
    const m = computeMetrics(board, now);
    expect(m.fanoutWidths).toEqual([
      { width: 1, count: 1, failed: 0 },
      { width: 3, count: 2, failed: 1 },
    ]);
  });

  it("sums tool calls across sessions", () => {
    const board = summarise([
      task({ id: "a", updatedAt: now, tools: { Bash: 5, Read: 2 } }),
      task({ id: "b", updatedAt: now, tools: { Bash: 3 } }),
    ]);
    const m = computeMetrics(board, now);
    expect(m.tools[0]).toEqual({ name: "Bash", calls: 8 });
    expect(m.totals.toolCalls).toBe(10);
  });
});
