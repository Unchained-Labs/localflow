/**
 * The rate, the block, and the four ways both of them lie.
 *
 * Every case here has a wrong-but-plausible implementation that produces a
 * number rather than an error, which is what makes them worth asserting:
 *
 *   * cutting the timeline into fixed five-hour slabs instead of opening a
 *     block at the first session — a board full of sessions still renders, with
 *     the wrong block boundaries and the wrong "time remaining";
 *   * dividing spend by the window instead of by the part of the window the
 *     board could see — three minutes of work read as an hourly rate;
 *   * treating an unpriced session as $0 — a confident under-report, the one
 *     failure this repo exists not to ship;
 *   * projecting the rest of a block from its first ninety seconds.
 */
import { describe, expect, it } from "vitest";

import { BLOCK_MS, blocksOf, burnOver, burnRates } from "../src/burn.js";
import { computeMetrics } from "../src/metrics.js";
import { summarise } from "../src/board.js";
import type { Task, Usage } from "../src/types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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

describe("burnOver", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");

  it("states no rate at all when nothing has been observed", () => {
    // Not "$0.00/h". An empty board has not measured a quiet hour; it has not
    // measured anything, and the two must not render the same.
    const w = burnOver([], HOUR, now);
    expect(w.costPerHour).toBeNull();
    expect(w.tokensPerHour).toBeNull();
    expect(w.sampleMs).toBe(0);
    expect(w.note).toMatch(/nothing observed/i);
  });

  it("reports a genuinely quiet hour as zero, not as unknown", () => {
    // The mirror of the case above: the board has three days of history, so it
    // did watch the whole hour, and the hour really was empty.
    const board = [task({ id: "old", updatedAt: now - 3 * DAY, costUsd: 5 })];
    const w = burnOver(board, HOUR, now);
    expect(w.sessions).toBe(0);
    expect(w.sampleMs).toBe(HOUR);
    expect(w.costPerHour).toBe(0);
    expect(w.thin).toBe(false);
    expect(w.note).toBe("");
  });

  it("divides by the observed sample, not the window, and says the sample is thin", () => {
    // $3 in the three minutes since this board started. Dividing by the window
    // gives $3/h and dividing by the sample gives $60/h — the second is the
    // arithmetic, but only if it arrives with the sample width attached.
    const w = burnOver([task({ id: "a", updatedAt: now - 3 * MINUTE, costUsd: 3 })], HOUR, now);
    expect(w.sampleMs).toBe(3 * MINUTE);
    expect(w.costPerHour).toBeCloseTo(60, 6);
    expect(w.thin).toBe(true);
    expect(w.note).toMatch(/short sample/i);
  });

  it("has no spend rate when nothing in the window could be priced", () => {
    // The single most important assertion in this file. A $0.00/h burn rate for
    // an hour of unpriced work is a wrong number that looks like a right one.
    const w = burnOver(
      [
        task({ id: "a", updatedAt: now - 2 * HOUR, costUsd: 1 }), // outside, for coverage
        task({ id: "b", updatedAt: now - 10 * MINUTE, costUsd: null, usage: usage({ output: 600 }) }),
      ],
      HOUR,
      now,
    );
    expect(w.sessions).toBe(1);
    expect(w.costUsd).toBeNull();
    expect(w.costPerHour).toBeNull();
    // Tokens are measured rather than looked up, so that rate survives.
    expect(w.tokensPerHour).toBe(600);
    expect(w.note).toMatch(/no price is known/i);
  });

  it("calls a partly-priced rate a floor rather than a total", () => {
    const w = burnOver(
      [
        task({ id: "seed", updatedAt: now - 2 * HOUR, costUsd: 0 }),
        task({ id: "a", updatedAt: now - 30 * MINUTE, costUsd: 2 }),
        task({ id: "b", updatedAt: now - 20 * MINUTE, costUsd: null }),
      ],
      HOUR,
      now,
    );
    expect(w.costPerHour).toBe(2);
    expect(w.costIsFloor).toBe(true);
    expect(w.note).toMatch(/floor, not a total/i);
  });

  it("counts a session that began before the window and says the rate is bunched", () => {
    // The board knows one cumulative total per session and one timestamp for
    // it. A nine-hour session therefore pays for itself entirely inside the
    // last hour it touched. That is the honest reading of the data, and it is
    // only honest if the window says so.
    const w = burnOver(
      [task({ id: "long", startedAt: now - 9 * HOUR, updatedAt: now - MINUTE, costUsd: 40 })],
      HOUR,
      now,
    );
    expect(w.straddling).toBe(1);
    // Nine hours of evidence covers the whole window, so the rate is $40/h and
    // not the $2,400/h you get by measuring coverage from last activity alone.
    expect(w.sampleMs).toBe(HOUR);
    expect(w.costPerHour).toBe(40);
    expect(w.thin).toBe(false);
    expect(w.note).toMatch(/bunched rather than spread/i);
  });

  it("includes a session on the window's own edge and excludes the one before it", () => {
    const tasks = [
      task({ id: "seed", updatedAt: now - 3 * DAY, costUsd: 0 }),
      task({ id: "edge", updatedAt: now - HOUR, costUsd: 1 }),
      task({ id: "past", updatedAt: now - HOUR - 1, costUsd: 1 }),
    ];
    expect(burnOver(tasks, HOUR, now).sessions).toBe(1);
  });

  it("reports one window per configured width", () => {
    const rates = burnRates([task({ id: "a", updatedAt: now, costUsd: 1 })], now);
    expect(rates.map((r) => r.windowMs)).toEqual([HOUR, DAY]);
  });
});

describe("blocksOf", () => {
  const nine30 = Date.parse("2026-08-18T09:30:00Z");

  it("opens a block at the first session, floored to the hour", () => {
    const blocks = blocksOf([task({ id: "a", updatedAt: nine30, costUsd: 1 })], nine30 + MINUTE);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.startedAt).toBe(Date.parse("2026-08-18T09:00:00Z"));
    expect(blocks[0]!.endsAt).toBe(Date.parse("2026-08-18T14:00:00Z"));
  });

  it("keeps sessions three hours apart in one block", () => {
    // The slab implementation — floor(t / 5h) * 5h from the epoch — puts 09:30
    // and 12:30 either side of the 10:00 UTC boundary and reports two blocks.
    // The count is the assertion: both versions produce a plausible board.
    const blocks = blocksOf(
      [
        task({ id: "a", updatedAt: nine30, costUsd: 1 }),
        task({ id: "b", updatedAt: nine30 + 3 * HOUR, costUsd: 2 }),
      ],
      nine30 + 3 * HOUR,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.sessions).toBe(2);
    expect(blocks[0]!.costUsd).toBe(3);
  });

  it("starts a new block for a session landing exactly on the boundary", () => {
    // The end is exclusive: the limit has reset by then, so the session belongs
    // to the window that just opened, not to the one that just closed.
    const start = Date.parse("2026-08-18T09:00:00Z");
    const blocks = blocksOf(
      [
        task({ id: "a", updatedAt: start, costUsd: 1 }),
        task({ id: "b", updatedAt: start + BLOCK_MS, costUsd: 2 }),
      ],
      start + BLOCK_MS,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.costUsd).toBe(1);
    expect(blocks[1]!.startedAt).toBe(start + BLOCK_MS);
    expect(blocks[1]!.active).toBe(true);
    expect(blocks[0]!.active).toBe(false);
    expect(blocks[0]!.remainingMs).toBe(0);
  });

  it("projects the rest of the block from the block clock", () => {
    // One hour into a five-hour block, $2 spent. The block clock runs from
    // 09:00 even though the first session arrived at 09:30, so the projection
    // is 5x, not the 10x you get by measuring from the first session.
    const start = Date.parse("2026-08-18T09:00:00Z");
    const blocks = blocksOf([task({ id: "a", updatedAt: nine30, costUsd: 2 })], start + HOUR);
    const b = blocks[0]!;
    expect(b.active).toBe(true);
    expect(b.remainingMs).toBe(4 * HOUR);
    expect(b.projectedCostUsd).toBeCloseTo(10, 6);
  });

  it("refuses to project a block that has barely started", () => {
    const start = Date.parse("2026-08-18T09:00:00Z");
    const b = blocksOf([task({ id: "a", updatedAt: start + MINUTE, costUsd: 2 })], start + 2 * MINUTE)[0]!;
    expect(b.projectedCostUsd).toBeNull();
    expect(b.projectedTokens).toBeNull();
    expect(b.note).toMatch(/too little to project/i);
  });

  it("has no spend and no projection for a block nobody could price", () => {
    const start = Date.parse("2026-08-18T09:00:00Z");
    const b = blocksOf(
      [task({ id: "a", updatedAt: start + HOUR, costUsd: null, usage: usage({ output: 100 }) })],
      start + 2 * HOUR,
    )[0]!;
    expect(b.costUsd).toBeNull();
    expect(b.startedAt).toBe(start + HOUR); // the block opens at its first session
    expect(b.projectedCostUsd).toBeNull();
    // Tokens still project: they were counted, not priced. One hour into the
    // block with 100 tokens spent projects to 500 by the reset.
    expect(b.projectedTokens).toBeCloseTo(500, 6);
    expect(b.note).toMatch(/no price is known/i);
  });

  it("flags a block whose spend was partly earned under the previous one", () => {
    const start = Date.parse("2026-08-18T09:00:00Z");
    const b = blocksOf(
      [task({ id: "long", startedAt: start - 3 * HOUR, updatedAt: start + HOUR, costUsd: 9 })],
      start + 2 * HOUR,
    )[0]!;
    expect(b.straddling).toBe(1);
    expect(b.note).toMatch(/previous limit window/i);
  });

  it("closes a block when the next session is a day later", () => {
    const blocks = blocksOf(
      [
        task({ id: "a", updatedAt: nine30, costUsd: 1 }),
        task({ id: "b", updatedAt: nine30 + DAY, costUsd: 1 }),
      ],
      nine30 + DAY,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks.filter((b) => b.active)).toHaveLength(1);
  });

  it("keeps only the most recent blocks", () => {
    const tasks = Array.from({ length: 30 }, (_, i) =>
      task({ id: `t${i}`, updatedAt: nine30 + i * DAY, costUsd: 1 }),
    );
    expect(blocksOf(tasks, nine30 + 30 * DAY, 5)).toHaveLength(5);
  });
});

describe("computeMetrics", () => {
  const now = Date.parse("2026-08-18T12:00:00Z");

  it("carries the rates and the current block on the payload", () => {
    const board = summarise([
      task({ id: "a", updatedAt: now - 2 * HOUR, costUsd: 1, usage: usage({ output: 100 }) }),
      task({ id: "b", updatedAt: now - 10 * MINUTE, costUsd: 3, usage: usage({ output: 200 }) }),
    ]);
    const m = computeMetrics(board, now);
    expect(m.burn.map((b) => b.windowMs)).toEqual([HOUR, DAY]);
    expect(m.burn[1]!.costUsd).toBe(4);
    expect(m.currentBlock).not.toBeNull();
    expect(m.currentBlock!.sessions).toBe(2);
    expect(m.blocks.at(-1)).toBe(m.currentBlock);
  });

  it("has no current block when the last one has already reset", () => {
    const board = summarise([task({ id: "a", updatedAt: now - 3 * DAY, costUsd: 1 })]);
    const m = computeMetrics(board, now);
    expect(m.blocks).toHaveLength(1);
    expect(m.currentBlock).toBeNull();
  });
});
