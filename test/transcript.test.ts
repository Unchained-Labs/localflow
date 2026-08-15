import { appendFileSync, copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { advance, cacheHitRate, emptyState, fold } from "../src/transcript.js";
import { laneFor, outcomeFor, slugForCwd, titleFor, toTask } from "../src/claude.js";
import { summarise } from "../src/board.js";
import { looksLikeVerifierPanel, notesFor, observedSpec, promptDivergence, tierFor } from "../src/graph.js";
import type { LiveSession, TranscriptState } from "../src/types.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const TRANSCRIPT = join(FIXTURES, "transcript.jsonl");

function parsed(): TranscriptState {
  const s = emptyState("fixture-0001");
  advance(TRANSCRIPT, s);
  return s;
}

describe("reading a transcript", () => {
  const s = parsed();

  it("takes the AI title over the prompt", () => {
    expect(s.title).toBe("Wire the invoice exporter");
  });

  it("counts human turns, not tool results", () => {
    // The fixture has one typed prompt and three `user` lines. Two of those are
    // tool results being fed back. On the real transcript this was written
    // against, counting them all reported 590 turns for a six-turn conversation.
    expect(s.turns).toBe(1);
  });

  it("counts each message id once, however many times it is re-emitted", () => {
    // msg_aaa appears three times, byte-identical, because usage is re-emitted as
    // a message streams. Summing every line inflated output tokens by 2.25x on
    // the 17MB transcript this rule came from — every cost on the board would
    // have been wrong by that factor.
    expect(s.assistantMessages).toBe(4);
    expect(s.usage.output).toBe(250 + 120 + 300 + 180);
  });

  it("splits cache writes by TTL, because they bill differently", () => {
    expect(s.usage.cacheWrite1h).toBe(2000 + 500 + 800);
    expect(s.usage.cacheWrite5m).toBe(900);
  });

  it("ignores synthetic messages when deciding which model is in use", () => {
    // `<synthetic>` is a message the client produced locally, not a model call.
    expect(s.model).toBe("claude-opus-5");
  });

  it("tracks the queue through enqueue, dequeue and remove", () => {
    // Three enqueued, the oldest dequeued, the named one removed.
    expect(s.queue).toEqual(["second queued prompt"]);
  });

  it("counts tool calls and tool errors", () => {
    expect(s.tools).toMatchObject({ Read: 1, Bash: 1, Agent: 5 });
    expect(s.toolErrors).toBe(2);
  });

  it("reports lines it could not parse instead of ignoring them", () => {
    // A file we cannot read is not a file with nothing in it.
    expect(s.unreadableLines).toBe(1);
  });

  it("records turn durations", () => {
    expect(s.turnDurationsMs).toEqual([184_000]);
  });

  it("computes the cache hit rate over every input token", () => {
    const r = cacheHitRate(s.usage)!;
    const inputs = s.usage.input + s.usage.cacheRead + s.usage.cacheWrite1h + s.usage.cacheWrite5m;
    expect(r).toBeCloseTo(s.usage.cacheRead / inputs, 10);
    expect(r).toBeGreaterThan(0.9);
  });
});

describe("fan-outs", () => {
  const s = parsed();

  it("groups agent calls by the message that issued them", () => {
    // Calls sharing an assistant message run concurrently; calls in separate
    // messages ran one after another. The grouping is the graph.
    expect(s.fanouts.map((f) => f.width)).toEqual([3, 2]);
  });

  it("attributes a failed child to the fan-out it came from", () => {
    expect(s.fanouts[0]!.failed).toBe(1);
    expect(s.fanouts[1]!.failed).toBe(0);
  });

  it("spots a verifier panel by what the children were asked", () => {
    expect(looksLikeVerifierPanel(s.fanouts[0]!)).toBe(true);
    // The second group writes a migration and runs a benchmark — not verifiers.
    expect(looksLikeVerifierPanel(s.fanouts[1]!)).toBe(false);
  });

  it("measures how much the children's prompts differ", () => {
    // Three identical prompts: no divergence at all, which is the whole finding.
    expect(promptDivergence(s.fanouts[0]!)).toBeCloseTo(0, 6);
    expect(promptDivergence(s.fanouts[1]!)).toBeGreaterThan(0.5);
  });
});

describe("reading incrementally", () => {
  it("parses only what was appended, and reaches the same answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "localflow-"));
    const path = join(dir, "t.jsonl");
    const all = readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean);
    const half = Math.floor(all.length / 2);

    // First half.
    const partial = emptyState("fixture-0001");
    copyFileSync("/dev/null", path);
    appendFileSync(path, `${all.slice(0, half).join("\n")}\n`);
    const first = advance(path, partial);
    expect(first.consumed).toBeGreaterThan(0);

    // Nothing new: no work, no double counting.
    const idle = advance(path, partial);
    expect(idle.consumed).toBe(0);
    const outputAfterHalf = partial.usage.output;

    // Append the rest.
    appendFileSync(path, `${all.slice(half).join("\n")}\n`);
    advance(path, partial);
    expect(partial.usage.output).toBeGreaterThan(outputAfterHalf);

    const oneShot = parsed();
    expect(partial.usage).toEqual(oneShot.usage);
    expect(partial.fanouts.map((f) => f.width)).toEqual(oneShot.fanouts.map((f) => f.width));
    expect(partial.queue).toEqual(oneShot.queue);
  });

  it("never commits an offset past the last complete line", () => {
    // A transcript being appended to right now usually ends mid-object. Reading
    // to EOF and remembering that offset would drop the line when it completes.
    const dir = mkdtempSync(join(tmpdir(), "localflow-"));
    const path = join(dir, "t.jsonl");
    appendFileSync(path, `${JSON.stringify({ type: "ai-title", aiTitle: "done" })}\n`);
    appendFileSync(path, '{"type":"ai-tit');
    const s = emptyState("x");
    advance(path, s);
    expect(s.title).toBe("done");

    appendFileSync(path, 'le","aiTitle":"complete now"}\n');
    advance(path, s);
    expect(s.title).toBe("complete now");
    expect(s.unreadableLines).toBe(0);
  });

  it("starts over when the file shrinks", () => {
    const s = emptyState("x");
    s.offset = 10_000_000;
    s.usage.output = 999;
    advance(TRANSCRIPT, s);
    expect(s.usage.output).toBe(850);
  });

  it("treats a missing file as nothing to read, not as a crash", () => {
    const s = emptyState("x");
    expect(advance("/nonexistent/nope.jsonl", s).consumed).toBe(0);
  });
});

describe("lanes and titles", () => {
  const live = (status: string): LiveSession => ({
    pid: 1,
    sessionId: "s",
    cwd: "/tmp",
    kind: "interactive",
    startedAt: 0,
    name: "n",
    status,
  });

  it("busy is running", () => {
    expect(laneFor(live("busy"), undefined)).toBe("running");
  });

  it("idle with prompts waiting is queued", () => {
    const s = emptyState("s");
    s.queue.push("something");
    expect(laneFor(live("idle"), s)).toBe("queued");
  });

  it("idle with an empty queue is waiting on you", () => {
    // The single most useful thing this board shows: a session blocked on a
    // question is invisible from the terminal you are not looking at.
    expect(laneFor(live("idle"), emptyState("s"))).toBe("waiting");
  });

  it("absent from the registry is ended", () => {
    expect(laneFor(undefined, undefined)).toBe("ended");
  });

  it("never claims a session succeeded", () => {
    // Nothing local records whether a session did what it was asked. The only
    // two outcomes are "we saw tool errors" and "not recorded".
    const clean = emptyState("s");
    expect(outcomeFor(clean)).toBe("unknown");
    const errored = parsed();
    expect(outcomeFor(errored)).toBe("errors-seen");
  });

  it("falls back through title, prompt and name", () => {
    const s = emptyState("s");
    expect(titleFor(s, live("idle"), "abcdef123")).toBe("n");
    s.lastPrompt = "do the thing";
    expect(titleFor(s, live("idle"), "abcdef123")).toBe("do the thing");
    s.title = "The Thing";
    expect(titleFor(s, live("idle"), "abcdef123")).toBe("The Thing");
  });

  it("slugs a working directory the way Claude Code does", () => {
    expect(slugForCwd("/home/w/dev/graph-claude")).toBe("-home-w-dev-graph-claude");
    expect(slugForCwd("/tmp/a_b.c")).toBe("-tmp-a-b-c");
  });
});

describe("the board", () => {
  const s = parsed();
  const task = toTask(
    "fixture-0001",
    { pid: 5, sessionId: "fixture-0001", cwd: "/home/dev/acme", kind: "interactive", startedAt: 1, name: "acme-1", status: "idle" },
    s,
    TRANSCRIPT,
  );

  it("prices a session from its measured tokens", () => {
    expect(task.costUsd).not.toBeNull();
    expect(task.costUsd!).toBeGreaterThan(0);
  });

  it("puts a session with a queue in the queued lane", () => {
    expect(task.lane).toBe("queued");
  });

  it("totals only what it could price, and says null otherwise", () => {
    const unpriced = { ...task, model: undefined, costUsd: null };
    const b = summarise([task, unpriced]);
    expect(b.totals.costUsd).toBeCloseTo(task.costUsd!, 10);
    expect(b.lanes.queued).toBe(2);
  });

  it("reports null rather than zero when nothing could be priced", () => {
    // $0.00 reads as "this was free". Null reads as "we do not know", which is
    // the true statement.
    const b = summarise([{ ...task, costUsd: null }]);
    expect(b.totals.costUsd).toBeNull();
  });

  it("sorts running first and most-recently-changed within a lane", () => {
    const older = { ...task, id: "old", lane: "running" as const, updatedAt: 1 };
    const newer = { ...task, id: "new", lane: "running" as const, updatedAt: 2 };
    const ended = { ...task, id: "end", lane: "ended" as const, updatedAt: 99 };
    const b = summarise([ended, older, newer]);
    expect(b.tasks.map((t) => t.id)).toEqual(["new", "old", "end"]);
  });
});

describe("the graph that ran", () => {
  const s = parsed();
  const task = toTask("fixture-0001", undefined, s, TRANSCRIPT);
  const spec = observedSpec(task);

  it("emits one node per observed fan-out, plus the session", () => {
    expect(spec.nodes.map((n) => n.id)).toEqual(["session", "verify-1", "fanout-2"]);
  });

  it("marks a verifier panel as one, with the children as its lenses", () => {
    const v = spec.nodes.find((n) => n.id === "verify-1")!;
    expect(v.harness?.kind).toBe("diverse-lens");
    expect(v.harness?.lenses).toHaveLength(3);
    expect(v.fanout?.width).toBe(3);
  });

  it("records every observed sequence as a barrier, with the reason", () => {
    // The second group did not start until the first returned. That is a
    // measurement. Whether it *had* to wait is graphlint's question, not ours.
    expect(spec.edges).toHaveLength(2);
    for (const e of spec.edges) {
      expect(e.barrier).toBe(true);
      expect(e.barrierReason).toMatch(/observed/);
    }
  });

  it("carries provenance so nothing downstream mistakes it for a plan", () => {
    expect(spec.observed.sessionId).toBe("fixture-0001");
    expect(spec.observed.widestFanout).toBe(3);
    expect(spec.observed.totalChildren).toBe(5);
    expect(spec.observed.failedChildren).toBe(1);
    expect(spec.description).toMatch(/Shape is measured; intent is not/);
  });

  it("maps models onto the tier vocabulary preflight uses", () => {
    expect(tierFor("claude-haiku-4-5")).toBe("cheap");
    expect(tierFor("claude-sonnet-5")).toBe("standard");
    expect(tierFor("claude-opus-5")).toBe("deep");
    expect(tierFor("something-else")).toBeUndefined();
  });

  it("calls out three identical verifiers", () => {
    const notes = notesFor(task);
    const correlated = notes.find((n) => n.rule === "correlated-verifiers");
    expect(correlated).toBeDefined();
    expect(correlated!.message).toMatch(/100% alike/);
  });

  it("reports the failed child", () => {
    expect(notesFor(task).some((n) => n.rule === "child-errors")).toBe(true);
  });
});
