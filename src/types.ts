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
  source: "claude" | "otter";
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
}

export interface BoardSummary {
  tasks: Task[];
  lanes: Record<Lane, number>;
  totals: { usage: Usage; costUsd: number | null; sessions: number; cacheHitRate: number | null };
  /** Sessions the registry lists that we could not enrich, and why. */
  degraded: { id: string; reason: string }[];
  generatedAt: number;
}
