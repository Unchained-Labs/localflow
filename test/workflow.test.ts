/**
 * The workflow runner.
 *
 * This is the first thing in localflow that *spends money on its own*, so the
 * tests are mostly about what it refuses to do. The execute function is swapped
 * out throughout: what is being pinned is the scheduling and the refusals, not
 * Claude Code, and a test suite that shelled out to a model would be measuring
 * somebody else's uptime.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dependencies,
  fillPrompt,
  findCycle,
  listWorkflows,
  readWorkflow,
  runWorkflow,
  saveWorkflow,
  validate,
} from "../src/workflow.js";
import type { NodeRun, WorkflowSpec } from "../src/workflow.js";

const dir = mkdtempSync(`${tmpdir()}/lf-wf-`);

/** A workflow whose nodes all sit in a real directory. */
function spec(over: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    name: "demo",
    cwd: dir,
    nodes: [
      { id: "scope", prompt: "map the work" },
      { id: "build", prompt: "do it: {{input}}" },
    ],
    edges: [{ from: "scope", to: "build" }],
    ...over,
  };
}

/** An execute that always succeeds, recording the prompt it was handed. */
function recorder() {
  const seen: { id: string; prompt: string; index: number }[] = [];
  const execute = async (node: { id: string }, prompt: string, index: number): Promise<NodeRun> => {
    seen.push({ id: node.id, prompt, index });
    return { id: node.id, state: "done", output: `output of ${node.id}`, costUsd: 0.5 };
  };
  return { seen, execute };
}

/** Gates are off in most tests: they are the subject of their own describe. */
const NO_GATES = { family: { bin: "/nonexistent/tool" } };

describe("validation", () => {
  it("accepts a workflow whose directories exist", () => {
    expect(validate(spec())).toEqual([]);
  });

  it("refuses a node with no prompt", () => {
    const bad = validate(spec({ nodes: [{ id: "a", prompt: "  " }], edges: [] }));
    expect(bad).toHaveLength(1);
    expect(bad[0]?.message).toMatch(/prompt is empty/);
  });

  it("holds a workflow to the same allowed roots as spawn", () => {
    // A workflow is a file on disk. If it could name any directory, the
    // --allow-root flag would be decorative.
    const bad = validate(spec(), { allowedRoots: ["/somewhere/else"] });
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]?.message).toMatch(/outside the allowed roots/);
  });

  it("names the nodes in a cycle rather than just reporting one", () => {
    const looped = spec({
      nodes: [
        { id: "a", prompt: "x" },
        { id: "b", prompt: "y" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    expect(findCycle(looped)).toEqual(["a", "b", "a"]);
    expect(validate(looped).some((p) => /depend on each other in a loop: a → b → a/.test(p.message))).toBe(true);
  });

  it("refuses an edge to a node that does not exist", () => {
    const bad = validate(spec({ edges: [{ from: "scope", to: "ghost" }] }));
    expect(bad.some((p) => /unknown node "ghost"/.test(p.message))).toBe(true);
  });

  it("reports every problem, not the first", () => {
    const bad = validate(spec({ nodes: [{ id: "a", prompt: "" }, { id: "a", prompt: "" }], edges: [] }));
    expect(bad.length).toBeGreaterThan(2);
  });
});

describe("dependencies", () => {
  it("reads them off the edges", () => {
    expect(dependencies(spec()).get("build")).toEqual(["scope"]);
    expect(dependencies(spec()).get("scope")).toEqual([]);
  });
});

describe("prompt substitution", () => {
  it("is literal, so the prompt reads as what was sent", () => {
    expect(fillPrompt("do {{input}} as {{index}} of {{width}}", "X", 0, 3)).toBe("do X as 1 of 3");
  });

  it("leaves a prompt with no placeholders alone", () => {
    expect(fillPrompt("just this", "X", 0, 1)).toBe("just this");
  });
});

describe("running", () => {
  it("runs a dependency before what depends on it, and carries the output", async () => {
    const { seen, execute } = recorder();
    const run = await runWorkflow(spec(), { execute, ...NO_GATES });
    expect(run.state).toBe("done");
    expect(seen.map((s) => s.id)).toEqual(["scope", "build"]);
    expect(seen[1]?.prompt).toBe("do it: output of scope");
  });

  it("sums what the runs actually reported", async () => {
    const { execute } = recorder();
    const run = await runWorkflow(spec(), { execute, ...NO_GATES });
    expect(run.costUsd).toBeCloseTo(1.0);
  });

  it("issues a fan-out's children together", async () => {
    let inFlight = 0;
    let peak = 0;
    const run = await runWorkflow(
      spec({
        nodes: [{ id: "panel", prompt: "check it, pass {{index}}", fanout: { over: "agents", width: 4 } }],
        edges: [],
      }),
      {
        ...NO_GATES,
        execute: async (node, prompt, index) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return { id: node.id, index, state: "done", output: prompt };
        },
      },
    );
    expect(peak).toBe(4);
    expect(run.nodes.filter((n) => n.state === "done")).toHaveLength(4);
    // Each child knows which one it is, so a panel can vary.
    expect(run.nodes.map((n) => n.output)).toContain("check it, pass 3");
  });

  it("skips what depended on a failure, and says which node did it", async () => {
    const run = await runWorkflow(spec(), {
      ...NO_GATES,
      execute: async (node) =>
        node.id === "scope"
          ? { id: node.id, state: "failed", detail: "the model refused" }
          : { id: node.id, state: "done" },
    });
    // The distinction the runner exists to keep: skipped is not completed.
    const build = run.nodes.find((n) => n.id === "build");
    expect(build?.state).toBe("skipped");
    expect(build?.detail).toMatch(/scope did not succeed/);
    expect(run.state).toBe("failed");
  });

  it("fails a node when one child of its fan-out failed", async () => {
    // Downstream asked for this node's output; a partial panel is not that.
    const run = await runWorkflow(
      spec({
        nodes: [
          { id: "panel", prompt: "x", fanout: { over: "agents", width: 3 } },
          { id: "after", prompt: "y" },
        ],
        edges: [{ from: "panel", to: "after" }],
      }),
      {
        ...NO_GATES,
        execute: async (node, _p, index) =>
          index === 1
            ? { id: node.id, index, state: "failed", detail: "boom" }
            : { id: node.id, index, state: "done" },
      },
    );
    expect(run.nodes.find((n) => n.id === "after")?.state).toBe("skipped");
  });

  it("refuses an invalid workflow before running anything", async () => {
    const { seen, execute } = recorder();
    const run = await runWorkflow(spec({ nodes: [{ id: "a", prompt: "" }], edges: [] }), {
      execute,
      ...NO_GATES,
    });
    expect(run.state).toBe("refused");
    expect(seen).toEqual([]);
  });

  it("honours the concurrency cap across independent nodes", async () => {
    let inFlight = 0;
    let peak = 0;
    await runWorkflow(
      spec({
        nodes: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, prompt: "x" })),
        edges: [],
      }),
      {
        ...NO_GATES,
        maxConcurrent: 2,
        execute: async (node) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return { id: node.id, state: "done" };
        },
      },
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("the gates", () => {
  it("runs when the tools are absent, and says they were not consulted", async () => {
    // Absent must not read as approval, but it must not block either: most
    // machines will not have all three installed.
    const { execute } = recorder();
    const run = await runWorkflow(spec(), { execute, ...NO_GATES });
    expect(run.state).toBe("done");
  });

  it("refuses when preflight expects more than the declared budget", async () => {
    const { seen, execute } = recorder();
    const fake = fakePreflight(9.99);
    const run = await runWorkflow(spec({ budget: { usd: 1 } }), {
      execute,
      family: { bin: fake },
    });
    expect(run.state).toBe("refused");
    expect(run.detail).toMatch(/over the \$1.00 budget/);
    // The point of a gate: nothing ran.
    expect(seen).toEqual([]);
  });

  it("runs when the estimate is inside the budget", async () => {
    const { execute } = recorder();
    const run = await runWorkflow(spec({ budget: { usd: 100 } }), {
      execute,
      family: { bin: fakePreflight(9.99) },
    });
    expect(run.state).toBe("done");
  });

  it("can be forced past a gate, and still reports what the gate said", async () => {
    const { seen, execute } = recorder();
    const run = await runWorkflow(spec({ budget: { usd: 1 } }), {
      execute,
      force: true,
      family: { bin: fakePreflight(9.99) },
    });
    expect(run.state).toBe("done");
    expect(seen.length).toBeGreaterThan(0);
  });
});

/** A preflight that always expects `usd`. Doubles as the graphlint probe. */
function fakePreflight(usd: number): string {
  const { chmodSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const d = mkdtempSync(`${tmpdir()}/lf-pf-`);
  const bin = join(d, "preflight");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
if [ "$1" = "check" ]; then echo '{"summary":{"errors":0,"warnings":0,"infos":0},"results":[]}'; exit 0; fi
echo '{"after":{"agents":{"low":1,"expected":2,"high":3},"usd":{"low":${usd},"expected":${usd},"high":${usd}},"nodes":[]}}'
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("storage", () => {
  it("round-trips a workflow through a file", () => {
    const d = mkdtempSync(`${tmpdir()}/lf-store-`);
    const saved = saveWorkflow(spec(), d);
    expect(saved.ok).toBe(true);
    expect(readWorkflow("demo", d)?.nodes).toHaveLength(2);
    expect(listWorkflows(d).map((w) => w.name)).toEqual(["demo"]);
  });

  it("refuses a name that is a path", () => {
    // The name becomes the filename directly, so this is the only thing
    // standing between a caller and an arbitrary write.
    const d = mkdtempSync(`${tmpdir()}/lf-store-`);
    expect(saveWorkflow(spec({ name: "../escape" }), d).ok).toBe(false);
    expect(readWorkflow("../../etc/passwd", d)).toBeNull();
  });

  it("names a broken file instead of hiding it", () => {
    const d = mkdtempSync(`${tmpdir()}/lf-store-`);
    writeFileSync(join(d, "bad.graph.json"), "{not json");
    const rows = listWorkflows(d);
    expect(rows[0]?.error).toBeTruthy();
    expect(rows[0]?.spec).toBeUndefined();
  });

  it("treats a missing directory as no workflows, not an error", () => {
    expect(listWorkflows(join(tmpdir(), "lf-nope-does-not-exist"))).toEqual([]);
  });
});
