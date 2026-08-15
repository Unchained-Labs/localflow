/**
 * The graph that actually ran.
 *
 * graphlint reads the graph you *wrote* and tells you what is wrong with it.
 * That is useful and it is also the easy half: a spec is a statement of
 * intent, and intent is not what your bill is made of. Every fan-out Claude Code
 * performs is recorded in the transcript — which agents were issued together,
 * how wide the group got, which of them came back with an error — so the graph
 * that ran can be reconstructed after the fact and handed to exactly the same
 * tools.
 *
 * The emitted document is a plain graph spec, the same shape
 * [graphlint](https://github.com/Unchained-Labs/graphlint) lints and
 * [preflight](https://github.com/Unchained-Labs/preflight) prices. So you can
 * lint a session you already paid for, and price the next one like it.
 *
 * What this cannot see, stated plainly rather than papered over: a transcript
 * records the calls, not the intent behind them. It cannot tell a barrier that
 * was load-bearing from one that was habit, and it cannot see a fan-out that
 * never happened because the model chose not to. It reports shape, not judgment.
 */
import type { Fanout, Task } from "./types.js";

export interface SpecNode {
  id: string;
  tier?: "cheap" | "standard" | "deep";
  phase?: string;
  model?: string;
  outputSchema?: string;
  fanout?: { over: string; width: number; maxConcurrent?: number };
  harness?: { kind: string; lenses?: string[]; passIf?: string };
}

export interface SpecEdge {
  from: string;
  to: string;
  channel?: string;
  barrier?: boolean;
  barrierReason?: string;
}

export interface ObservedSpec {
  name: string;
  description: string;
  nodes: SpecNode[];
  edges: SpecEdge[];
  /** Provenance. This spec was measured, and anything reading it should know. */
  observed: {
    sessionId: string;
    model?: string;
    fanouts: number;
    widestFanout: number;
    totalChildren: number;
    failedChildren: number;
    capturedAt: string;
  };
}

/** Map a model id onto the tier vocabulary preflight uses for its profiles. */
export function tierFor(model: string | undefined): "cheap" | "standard" | "deep" | undefined {
  if (!model) return undefined;
  if (/haiku/.test(model)) return "cheap";
  if (/sonnet/.test(model)) return "standard";
  if (/opus|fable|mythos/.test(model)) return "deep";
  return undefined;
}

/**
 * A fan-out whose children all ask the same question is a fan-out of one
 * verifier counted N times — the thing decorrelate exists to measure. Detecting
 * it needs no model: identical or near-identical child prompts are visible in
 * the transcript.
 */
export function looksLikeVerifierPanel(f: Fanout): boolean {
  if (f.width < 2) return false;
  const verbs = /\b(verify|verifies|check|checks|confirm|confirms|review|reviews|judge|judges|validate|validates|audit|audits|refute|refutes)\b/i;
  const verbal = f.children.filter((c) => verbs.test(c.description) || verbs.test(c.prompt.slice(0, 400)));
  return verbal.length >= Math.max(2, Math.ceil(f.width / 2));
}

/** How much the child prompts differ, 0 (identical) to 1 (nothing shared). */
export function promptDivergence(f: Fanout): number {
  if (f.width < 2) return 0;
  const sets = f.children.map((c) => new Set(tokenise(`${c.description} ${c.prompt}`)));
  let pairs = 0;
  let jaccardSum = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const union = a.size + b.size - inter;
      jaccardSum += union === 0 ? 1 : inter / union;
      pairs++;
    }
  }
  return pairs === 0 ? 0 : 1 - jaccardSum / pairs;
}

function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

/**
 * Build the spec for one session.
 *
 * Each observed fan-out becomes a node; consecutive fan-outs become an edge,
 * because a group issued after another group necessarily waited for it. Those
 * edges are marked `barrier: true` and carry a reason saying exactly that — the
 * barrier is a measurement, not an inference about whether it was needed.
 */
export function observedSpec(task: Task): ObservedSpec {
  const nodes: SpecNode[] = [];
  const edges: SpecEdge[] = [];
  const tier = tierFor(task.model);

  nodes.push({
    id: "session",
    phase: "Session",
    tier,
    model: task.model,
  });

  let previous = "session";
  task.fanouts.forEach((f, i) => {
    const id = `fanout-${i + 1}`;
    const panel = looksLikeVerifierPanel(f);
    nodes.push({
      id: panel ? `verify-${i + 1}` : id,
      phase: panel ? "Verify" : `Fan-out ${i + 1}`,
      tier,
      model: task.model,
      fanout: { over: "agents", width: f.width },
      ...(panel
        ? {
            harness: {
              kind: "diverse-lens",
              // The "lenses" are the child descriptions, because that is what
              // actually varied between them.
              lenses: f.children.map((c) => c.description || "(no description)"),
              passIf: "unknown",
            },
          }
        : {}),
    });
    const to = panel ? `verify-${i + 1}` : id;
    edges.push({
      from: previous,
      to,
      channel: "agents",
      // Every observed sequence is a real barrier: the second group did not
      // start until the first returned. Whether it *had* to is not visible here,
      // and graphlint is the thing that asks that question.
      barrier: true,
      barrierReason:
        previous === "session"
          ? "observed: the session issued this group and waited for it"
          : "observed: this group was issued only after the previous group returned",
    });
    previous = to;
  });

  const totalChildren = task.fanouts.reduce((a, f) => a + f.width, 0);
  return {
    name: `observed-${task.name}`,
    description:
      `Reconstructed from the transcript of session ${task.id}. ` +
      `${task.fanouts.length} fan-out(s), ${totalChildren} agent(s). Shape is measured; intent is not.`,
    nodes,
    edges,
    observed: {
      sessionId: task.id,
      model: task.model,
      fanouts: task.fanouts.length,
      widestFanout: task.fanouts.reduce((a, f) => Math.max(a, f.width), 0),
      totalChildren,
      failedChildren: task.fanouts.reduce((a, f) => a + f.failed, 0),
      capturedAt: new Date(task.updatedAt || Date.now()).toISOString(),
    },
  };
}

export interface GraphNote {
  level: "info" | "warn";
  rule: string;
  message: string;
}

/**
 * The observations localflow can make on its own, without shelling out.
 *
 * These are deliberately few. graphlint owns the rule set; duplicating it here
 * would produce two rule sets that disagree, and the family's whole claim is
 * that it does not do that. What is here is only what needs the *observed*
 * numbers to be sayable at all.
 */
export function notesFor(task: Task): GraphNote[] {
  const notes: GraphNote[] = [];

  for (const [i, f] of task.fanouts.entries()) {
    if (looksLikeVerifierPanel(f)) {
      const d = promptDivergence(f);
      if (d < 0.25) {
        notes.push({
          level: "warn",
          rule: "correlated-verifiers",
          message:
            `Fan-out ${i + 1} spawned ${f.width} verifiers whose prompts are ${Math.round((1 - d) * 100)}% alike. ` +
            "N identical verifiers are one verifier at N times the price — vary the lens, vary the model, " +
            "or replace one with an executable oracle.",
        });
      }
    }
    if (f.failed > 0) {
      notes.push({
        level: "warn",
        rule: "child-errors",
        message: `Fan-out ${i + 1}: ${f.failed} of ${f.width} agent(s) returned an error result.`,
      });
    }
  }

  if (task.fanouts.length >= 2) {
    const widths = task.fanouts.map((f) => f.width);
    const spread = Math.max(...widths) - Math.min(...widths);
    if (spread === 0 && widths.length >= 3) {
      notes.push({
        level: "info",
        rule: "uniform-width",
        message: `${widths.length} fan-outs all ${widths[0]} wide — a fixed width is usually a constant, not a measurement of the work.`,
      });
    }
  }

  if (task.cacheHitRate !== null && task.cacheHitRate < 0.3 && task.usage.input + task.usage.cacheRead > 100_000) {
    notes.push({
      level: "warn",
      rule: "low-cache-hit",
      message:
        `Only ${Math.round(task.cacheHitRate * 100)}% of input tokens came from cache. ` +
        "Cache reads bill at a tenth of the input rate, so this is the cheapest thing on the board to fix.",
    });
  }

  return notes;
}
