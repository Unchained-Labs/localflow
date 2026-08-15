/**
 * Reading a Claude Code transcript without reading it twice.
 *
 * A transcript is append-only JSONL at
 * `~/.claude/projects/<slugged-cwd>/<sessionId>.jsonl`, and on a long session it
 * gets large — the one this tool was written against is 17MB. A dashboard that
 * re-parses that every two seconds is a dashboard that heats your laptop, so the
 * reader is incremental: it keeps a byte offset and a partial line, and each poll
 * only parses what was appended since the last one.
 *
 * The counting rules below are the load-bearing part. They were derived by
 * measuring a real transcript, not by reading a schema, because there is no
 * published schema to read.
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";

import { ZERO_USAGE } from "./types.js";
import type { Fanout, TranscriptState, Usage } from "./types.js";

export function emptyState(sessionId: string): TranscriptState {
  return {
    sessionId,
    turns: 0,
    assistantMessages: 0,
    usage: { ...ZERO_USAGE },
    countedMessageIds: new Set(),
    tools: {},
    toolErrors: 0,
    queue: [],
    fanouts: [],
    turnDurationsMs: [],
    offset: 0,
    unreadableLines: 0,
  };
}

/** Tool-call ids belonging to Agent fan-outs, so their results can be matched later. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

interface ReadResult {
  state: TranscriptState;
  /** Bytes newly consumed. Zero means nothing changed. */
  consumed: number;
}

/**
 * Consume everything appended to `path` since `state.offset`, folding it in.
 *
 * Mutates and returns the same state object: this is called on a timer against
 * a live file, and allocating a fresh accumulator each poll would defeat the
 * point of tracking an offset at all.
 */
export function advance(path: string, state: TranscriptState, chunkBytes = 4 << 20): ReadResult {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { state, consumed: 0 };
  }

  // A shrinking file means it was rotated or replaced. Re-read from the top
  // rather than resuming into the middle of a line of some other file.
  if (size < state.offset) {
    const fresh = emptyState(state.sessionId);
    Object.assign(state, fresh);
  }
  if (size === state.offset) return { state, consumed: 0 };

  const fd = openSync(path, "r");
  let consumed = 0;
  try {
    let carry = "";
    let pos = state.offset;
    const buf = Buffer.allocUnsafe(chunkBytes);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(chunkBytes, size - pos), pos);
      if (n <= 0) break;
      const text = carry + buf.toString("utf8", 0, n);
      const lines = text.split("\n");
      // The last element is either an incomplete line or "" — either way it is
      // not ours to parse yet.
      carry = lines.pop() ?? "";
      for (const line of lines) fold(state, line);
      pos += n;
      consumed += n;
    }
    // Only commit the offset up to the last complete line. The tail of a file
    // being appended to right now is usually half a JSON object.
    state.offset = pos - Buffer.byteLength(carry, "utf8");
  } finally {
    closeSync(fd);
  }
  return { state, consumed };
}

/** Fold one JSONL line into the accumulated state. */
export function fold(s: TranscriptState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    s.unreadableLines++;
    return;
  }

  const type = d.type as string | undefined;
  const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : undefined;
  if (ts && (!s.lastActivityAt || ts > s.lastActivityAt)) s.lastActivityAt = ts;
  if (typeof d.cwd === "string") s.cwd = d.cwd;
  if (typeof d.gitBranch === "string" && d.gitBranch !== "HEAD") s.gitBranch = d.gitBranch;
  if (typeof d.version === "string") s.version = d.version;

  switch (type) {
    case "ai-title":
      if (typeof d.aiTitle === "string") s.title = d.aiTitle;
      return;

    case "last-prompt":
      if (typeof d.lastPrompt === "string") s.lastPrompt = d.lastPrompt;
      return;

    case "permission-mode":
      if (typeof d.permissionMode === "string") s.permissionMode = d.permissionMode;
      return;

    case "queue-operation":
      // Observed operations: enqueue, dequeue, remove. A prompt sitting in the
      // queue is work the session has accepted and not started, which is the
      // only thing on this board that is genuinely "queued".
      foldQueue(s, d);
      return;

    case "system":
      if (d.subtype === "turn_duration" && typeof d.durationMs === "number") {
        s.turnDurationsMs.push(d.durationMs);
      }
      return;

    case "user":
      foldUser(s, d);
      return;

    case "assistant":
      foldAssistant(s, d, ts);
      return;

    default:
      return;
  }
}

function foldQueue(s: TranscriptState, d: Record<string, unknown>): void {
  const content = typeof d.content === "string" ? d.content : undefined;
  switch (d.operation) {
    case "enqueue":
      if (content !== undefined) s.queue.push(content);
      return;
    case "dequeue": {
      // Dequeue reports no content, so the oldest entry is the one that ran.
      s.queue.shift();
      return;
    }
    case "remove": {
      const i = content === undefined ? -1 : s.queue.indexOf(content);
      if (i >= 0) s.queue.splice(i, 1);
      else s.queue.pop();
      return;
    }
    default:
      return;
  }
}

function foldUser(s: TranscriptState, d: Record<string, unknown>): void {
  // Most `user` lines are tool results being fed back, not somebody typing. Only
  // the ones carrying a human origin or a prompt source are turns; counting the
  // rest would report 590 turns for a conversation with six.
  const origin = d.origin as { kind?: string } | undefined;
  const isHuman = origin?.kind === "human" || typeof d.promptSource === "string";
  if (isHuman) s.turns++;

  const msg = d.message as { content?: unknown } | undefined;
  if (Array.isArray(msg?.content)) {
    for (const block of msg.content as Record<string, unknown>[]) {
      if (block?.type === "tool_result" && block.is_error === true) {
        s.toolErrors++;
        markFanoutFailure(s, String(block.tool_use_id ?? ""));
      }
    }
  }
}

function foldAssistant(s: TranscriptState, d: Record<string, unknown>, ts?: number): void {
  const m = d.message as Record<string, unknown> | undefined;
  if (!m) return;

  const model = typeof m.model === "string" ? m.model : undefined;
  // `<synthetic>` marks a message the client produced locally, not a model call.
  if (model && model !== "<synthetic>") s.model = model;
  if (typeof d.effort === "string") s.effort = d.effort;

  // A synthetic message was produced by the client, not by the API. It carries
  // no usage, so it costs nothing — but counting it as a model call would
  // understate tokens-per-call, and tokens-per-call is exactly what `calibrate`
  // hands to preflight.
  if (model === "<synthetic>") return;

  const id = typeof m.id === "string" ? m.id : undefined;

  // Usage is re-emitted verbatim as a message streams — up to ten copies of the
  // same object in the file measured here. Every copy of a given id was byte
  // identical, so counting once per id is exact rather than an approximation.
  // Summing every line instead inflated output tokens by 2.25x on that
  // transcript, which would have made every cost on the board wrong.
  if (id && !s.countedMessageIds.has(id)) {
    s.countedMessageIds.add(id);
    s.assistantMessages++;
    addUsage(s.usage, m.usage as Record<string, unknown> | undefined);
    collectToolCalls(s, m, id, ts);
  }
}

function addUsage(into: Usage, u: Record<string, unknown> | undefined): void {
  if (!u) return;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  into.input += n(u.input_tokens);
  into.output += n(u.output_tokens);
  into.cacheRead += n(u.cache_read_input_tokens);

  // Cache writes are billed by TTL, so the split matters more than the total.
  // `cache_creation` carries it; when it is absent, fall back to the aggregate
  // and attribute it to the 1-hour tier, which is what Claude Code writes —
  // guessing the cheaper tier would under-report the bill.
  const cc = u.cache_creation as Record<string, unknown> | undefined;
  if (cc) {
    into.cacheWrite5m += n(cc.ephemeral_5m_input_tokens);
    into.cacheWrite1h += n(cc.ephemeral_1h_input_tokens);
  } else {
    into.cacheWrite1h += n(u.cache_creation_input_tokens);
  }

  const details = u.output_tokens_details as Record<string, unknown> | undefined;
  into.thinking += n(details?.thinking_tokens);
}

function collectToolCalls(
  s: TranscriptState,
  m: Record<string, unknown>,
  messageId: string,
  ts?: number,
): void {
  const content = m.content;
  if (!Array.isArray(content)) return;

  const agents: Fanout["children"] = [];
  const agentIds: string[] = [];

  for (const block of content as Record<string, unknown>[]) {
    if (block?.type !== "tool_use") continue;
    const name = typeof block.name === "string" ? block.name : "unknown";
    s.tools[name] = (s.tools[name] ?? 0) + 1;
    s.lastToolName = name;

    if (AGENT_TOOLS.has(name)) {
      const input = (block.input ?? {}) as Record<string, unknown>;
      agents.push({
        description: String(input.description ?? "").slice(0, 200),
        prompt: String(input.prompt ?? "").slice(0, 2000),
        agentType: typeof input.subagent_type === "string" ? input.subagent_type : undefined,
      });
      if (typeof block.id === "string") agentIds.push(block.id);
    }
  }

  if (!agents.length) return;
  // Agent calls issued in one assistant message run concurrently; calls in
  // separate messages run one after another. So a message is exactly one
  // fan-out, and its width is the width that actually happened.
  s.fanouts.push({
    messageId,
    at: ts ?? Date.now(),
    width: agents.length,
    children: agents,
    failed: 0,
  });
  fanoutIds.set(s, [...(fanoutIds.get(s) ?? []), ...agentIds.map((id) => ({ id, messageId }))]);
}

/**
 * tool_use_id -> the fan-out it belongs to.
 *
 * Kept beside the state rather than inside it because it is bookkeeping for the
 * reader, not a fact about the session, and it must not end up in the JSON the
 * board serves.
 */
const fanoutIds = new WeakMap<TranscriptState, { id: string; messageId: string }[]>();

function markFanoutFailure(s: TranscriptState, toolUseId: string): void {
  if (!toolUseId) return;
  const entry = fanoutIds.get(s)?.find((e) => e.id === toolUseId);
  if (!entry) return;
  const f = s.fanouts.find((x) => x.messageId === entry.messageId);
  if (f) f.failed++;
}

/** Share of input tokens that came from the cache. Null when nothing was read. */
export function cacheHitRate(u: Usage): number | null {
  const total = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  if (total === 0) return null;
  return u.cacheRead / total;
}
