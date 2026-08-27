/**
 * The shapes localflow works in.
 *
 * Two of them are not ours and must not drift: `LiveSession` mirrors what
 * `claude agents --json` returns, and `Usage` mirrors the `usage` object inside
 * an assistant message in a Claude Code transcript. Both are read from a real
 * installation rather than invented, and the fixtures in `test/fixtures` are
 * captured from one.
 */

/** A row from `claude agents --json` — the live session registry. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: "interactive" | "background" | string;
  startedAt: number;
  name: string;
  /** Upstream status. Observed values: "busy", "idle". */
  status: string;
}

/**
 * Token counts as an assistant message reports them.
 *
 * The two cache-write fields are separate because they are billed differently,
 * and the difference is not small: a 1-hour cache write costs 2x the input rate
 * against 1.25x for a 5-minute one. Claude Code writes 1-hour entries, so
 * collapsing these into one number under-prices a real session by roughly a
 * third. See `pricing.ts` for how that was established.
 */
export interface Usage {
  input: number;
  output: number;
  /** Tokens served from the prompt cache, billed at a tenth of the input rate. */
  cacheRead: number;
  /** Written into the 5-minute cache. Billed at 1.25x input. */
  cacheWrite5m: number;
  /** Written into the 1-hour cache. Billed at 2x input. */
  cacheWrite1h: number;
  thinking: number;
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  thinking: 0,
};

/** Every token written into a cache, at either TTL. For display, not for billing. */
export function cacheWriteTotal(u: Usage): number {
  return u.cacheWrite5m + u.cacheWrite1h;
}

/**
 * A fresh zero total.
 *
 * Deliberately a function rather than `ZERO_USAGE`: every caller here is an
 * accumulator that mutates what it is given, and a shared constant handed to
 * two of them becomes a bug that surfaces in the third.
 */
export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
}

/** Accumulate `from` into `into`. */
export function addUsage(into: Usage, from: Usage): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite5m += from.cacheWrite5m;
  into.cacheWrite1h += from.cacheWrite1h;
  into.thinking += from.thinking;
}

/**
 * Every token that moved, for throughput.
 *
 * `thinking` is excluded on purpose: it is a subset of `output`, not a sixth
 * bucket beside it — `pricing.ts` bills input, output and the two cache lines
 * and never touches it. Adding it here would inflate a token rate by however
 * much the model thought, which is precisely the sessions you most want to
 * measure honestly.
 */
export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheRead + cacheWriteTotal(u);
}

/**
 * One observed parallel fan-out.
 *
 * Claude Code runs the `Agent` tool calls that share an assistant message
 * concurrently, and runs calls in separate messages one after another. So the
 * grouping *is* the graph: `width` is how wide the fan-out actually got, which
 * is a fact about a run rather than a number someone wrote in a spec.
 */
export interface Fanout {
  /** The assistant message the group was issued from. */
  messageId: string;
  at: number;
  width: number;
  children: { description: string; prompt: string; agentType?: string }[];
  /** Children whose tool_result came back with `is_error`. */
  failed: number;
}

/** Everything derivable from a transcript, accumulated incrementally. */
export interface TranscriptState {
  sessionId: string;
  title?: string;
  lastPrompt?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** Prompts a human actually sent. Tool results are also `user` lines; they are not turns. */
  turns: number;
  assistantMessages: number;
  usage: Usage;
  /** Message ids already counted, so a re-emitted message cannot bill twice. */
  countedMessageIds: Set<string>;
  tools: Record<string, number>;
  toolErrors: number;
  lastActivityAt?: number;
  lastToolName?: string;
  /** Prompts enqueued and not yet dequeued or removed. */
  queue: string[];
  fanouts: Fanout[];
  turnDurationsMs: number[];
  /** Byte offset consumed so far, so the next read starts where this one stopped. */
  offset: number;
  /** Lines that would not parse. A file we cannot read is not a file with nothing in it. */
  unreadableLines: number;
}

/**
 * Where a task sits on the board.
 *
 * There is deliberately no "succeeded" lane. Nothing in the local artefacts
 * says a session achieved what it was asked to do — only that it stopped. A
 * board that renders "done" as "went well" would be inventing the one fact its
 * user most wants, which is the same defect authsweep calls a false clean.
 */
export type Lane = "queued" | "running" | "waiting" | "ended";

/** What we can honestly say about how a session finished. */
export type Outcome = "unknown" | "errors-seen";

export interface Task {
  id: string;
  /**
   * Which adapter produced this card.
   *
   * Deliberately an open string rather than a union. It was `"claude" | "otter"`
   * while those were the only two readers, and every new tool meant editing this
   * line — which is the compiler telling you the set is not closed. The adapter
   * registry owns the values now; the board only needs to group by them.
   */
  source: string;
  lane: Lane;
  outcome: Outcome;
  title: string;
  name: string;
  cwd: string;
  branch?: string;
  status: string;
  kind: string;
  pid?: number;
  model?: string;
  effort?: string;
  startedAt: number;
  updatedAt: number;
  turns: number;
  lastPrompt?: string;
  lastToolName?: string;
  queue: string[];
  usage: Usage;
  /** Null when no price is known for the model — never zero. Otter's rule, and it is the right one. */
  costUsd: number | null;
  /** Share of input tokens served from cache. Null when nothing was read yet. */
  cacheHitRate: number | null;
  tools: Record<string, number>;
  toolErrors: number;
  fanouts: Fanout[];
  transcriptPath?: string;
  /** Set when the task is live in the registry but has no transcript we could read. */
  transcriptMissing?: boolean;
  /**
   * The declared device this session is running on. Absent means this machine.
   *
   * Absent rather than `"local"` on purpose: a board that labels every card with
   * a machine name is a board where the machine name stops being information.
   */
  device?: string;
  /** The session id as the far side knows it — `id` is prefixed with the device. */
  remoteId?: string;
  /**
   * Set when only the tail of the transcript was mirrored, so `usage` and
   * `costUsd` are floors rather than totals. Rendering a floor as a total is the
   * same defect as pricing an unknown model at zero.
   */
  partial?: boolean;
  /** Set while this card is the last known state of a device we cannot currently reach. */
  staleSince?: number;
}

export interface BoardSummary {
  tasks: Task[];
  lanes: Record<Lane, number>;
  totals: { usage: Usage; costUsd: number | null; sessions: number; cacheHitRate: number | null };
  /** Sessions the registry lists that we could not enrich, and why. */
  degraded: { id: string; reason: string }[];
  generatedAt: number;
  /** Vintage of the built-in price table these costs were derived from. */
  pricingVerified: string;
}
