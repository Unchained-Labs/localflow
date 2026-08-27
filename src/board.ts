/**
 * Assembling the board.
 *
 * One poll: ask the registry what is live, fold in whatever each transcript has
 * appended since last time, and produce the cards. The expensive part —
 * transcript parsing — happens once per session and then only on the tail, so
 * steady-state polling costs almost nothing regardless of how long the sessions
 * have been running.
 */
import { costOf, PRICING_VERIFIED } from "./pricing.js";
import { cacheHitRate } from "./transcript.js";
import { TranscriptCache, endedSessionIds, findTranscript, liveSessions, toTask } from "./claude.js";
import type { AdapterOptions } from "./claude.js";
import type { BoardSummary, Lane, LiveSession, Task, Usage } from "./types.js";

export interface BoardOptions extends AdapterOptions {
  /** How many ended sessions to keep on the board. */
  history?: number;
  /** Skip the registry call and use these rows. For tests. */
  sessions?: LiveSession[];
}

const EMPTY_LANES: Record<Lane, number> = { queued: 0, running: 0, waiting: 0, ended: 0 };

export class Board {
  private readonly cache = new TranscriptCache();
  private readonly opts: BoardOptions;

  constructor(opts: BoardOptions = {}) {
    this.opts = opts;
  }

  async poll(): Promise<BoardSummary> {
    const degraded: BoardSummary["degraded"] = [];

    let live: LiveSession[];
    if (this.opts.sessions) {
      live = this.opts.sessions;
    } else {
      try {
        live = await liveSessions(this.opts);
      } catch (e) {
        // A board that renders zero cards because the registry call failed looks
        // exactly like a machine with nothing running. Say which one it is.
        throw new Error(
          `could not read the session registry: ${(e as Error).message}. ` +
            "localflow runs `claude agents --json`; check that `claude` is on PATH, " +
            "or set LOCALFLOW_CLAUDE_BIN.",
        );
      }
    }

    const tasks: Task[] = [];

    for (const s of live) {
      const path = findTranscript(s.sessionId, s.cwd, this.opts);
      if (!path) {
        degraded.push({
          id: s.sessionId,
          reason: "no transcript found — the card shows registry data only, with no tokens or cost",
        });
      }
      const state = this.cache.refresh(s.sessionId, path);
      if (state?.unreadableLines) {
        degraded.push({
          id: s.sessionId,
          reason: `${state.unreadableLines} transcript line(s) would not parse and were skipped`,
        });
      }
      tasks.push(toTask(s.sessionId, s, state, path, this.opts));
    }

    const historyLimit = this.opts.history ?? 10;
    if (historyLimit > 0) {
      for (const e of endedSessionIds(live, this.opts, historyLimit)) {
        const state = this.cache.refresh(e.id, e.path);
        tasks.push(toTask(e.id, undefined, state, e.path, this.opts));
      }
    }

    return summarise(tasks, degraded, this.opts.asOf);
  }

  /** Drop cached parse state — used when a session ends and its file may be replaced. */
  forget(sessionId: string): void {
    this.cache.forget(sessionId);
  }

  get cachedSessions(): number {
    return this.cache.size;
  }
}

export function summarise(
  tasks: Task[],
  degraded: BoardSummary["degraded"] = [],
  asOf?: string,
): BoardSummary {
  const lanes = { ...EMPTY_LANES };
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
  let costUsd: number | null = null;
  let anyPriced = false;

  for (const t of tasks) {
    lanes[t.lane]++;
    usage.input += t.usage.input;
    usage.output += t.usage.output;
    usage.cacheRead += t.usage.cacheRead;
    usage.cacheWrite5m += t.usage.cacheWrite5m;
    usage.cacheWrite1h += t.usage.cacheWrite1h;
    usage.thinking += t.usage.thinking;
    if (t.costUsd !== null) {
      costUsd = (costUsd ?? 0) + t.costUsd;
      anyPriced = true;
    }
  }

  // Ordering is by lane, then by what changed most recently — a board sorted by
  // start time buries the session that just asked you a question.
  const laneOrder: Record<Lane, number> = { running: 0, queued: 1, waiting: 2, ended: 3 };
  tasks.sort((a, b) => laneOrder[a.lane] - laneOrder[b.lane] || b.updatedAt - a.updatedAt);

  return {
    tasks,
    lanes,
    totals: {
      usage,
      costUsd: anyPriced ? costUsd : null,
      sessions: tasks.length,
      cacheHitRate: cacheHitRate(usage),
    },
    degraded,
    generatedAt: Date.now(),
    // The vintage of the built-in price table. A cost figure without it is a
    // number the reader cannot date, and the board shows a running total.
    pricingVerified: PRICING_VERIFIED,
  };
}

/** Re-price a set of tasks, e.g. after an intro rate expires. Used by the tests. */
export function reprice(tasks: Task[], asOf: string): Task[] {
  return tasks.map((t) => ({ ...t, costUsd: costOf(t.usage, t.model, asOf) }));
}
