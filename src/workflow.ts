/**
 * Workflows: the half of this tool that was missing.
 *
 * localflow could watch a fleet and reconstruct the graph a session performed,
 * which makes it a very good instrument and not an orchestrator. You could not
 * *compose* anything with it. This is composition: a graph you write, that
 * localflow runs, on the same board that then shows you what it did.
 *
 * ## The spec is the family's spec
 *
 * A workflow is a `*.graph.json` — the same declarative shape graphlint lints
 * and preflight prices — with the fields execution needs added to each node:
 * a prompt, a directory, a model. graphlint ignores keys it does not know, so
 * one document is both the thing you run and the thing the family judges. That
 * is the whole point: **you can lint and price a workflow before it spends a
 * token**, using the tools that already do those jobs, rather than finding out
 * afterwards from a bill.
 *
 * ## What the runner actually does
 *
 * One node is one `claude -p --output-format json` run. That is deliberate:
 * `--bg` returns the moment a session registers and never tells you it
 * finished, so a dependency graph built on it would be a graph that cannot
 * wait. Headless runs block, report `session_id`, and report what the CLI
 * itself says the turn cost — so a finished node carries a measured cost rather
 * than an estimate, and the session it created shows up on the board like any
 * other.
 *
 * Edges are dependencies. A node starts when every node it depends on has
 * succeeded; nodes with no unmet dependency start together, up to a concurrency
 * cap. `{{input}}` in a prompt is replaced by the output of the nodes it
 * depends on — that substitution is the only data flow there is, and it is
 * literal: what you see in the prompt is what was sent.
 *
 * ## Refusals, which are most of the design
 *
 *   * **A node whose dependency failed is `skipped`, never `completed`.** The
 *     run reports it as skipped and says which upstream node did it. Rolling a
 *     skip up as success is how an orchestrator tells you it did work it did not do.
 *   * **A cycle is refused before anything starts.** Not run until it exhausts
 *     something.
 *   * **Every directory goes through the same allow-root check as spawn.** A
 *     workflow is a file; a file that could name any directory on the machine
 *     would make "allowed roots" decorative.
 *   * **graphlint errors and a blown preflight budget stop the run.** Both are
 *     overridable with `force`, and both are *skipped rather than assumed* when
 *     the tool is not installed — an absent linter never reads as a clean one.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { checkCwd, checkPrompt } from "./actions.js";
import type { ActionContext } from "./actions.js";
import { estimateObserved, lintObserved } from "./family.js";
import type { FamilyOptions } from "./family.js";

/** A node of a workflow: one unit of model work, and how to run it. */
export interface WorkflowNode {
  id: string;
  /** What to send. `{{input}}` is replaced by the upstream nodes' output. */
  prompt: string;
  /** Where to run it. Falls back to the workflow's `cwd`. */
  cwd?: string;
  model?: string;
  effort?: string;
  /** A named agent/subagent type, passed to `claude --agent`. */
  agent?: string;
  phase?: string;
  tier?: "cheap" | "standard" | "deep";
  /**
   * Run this node several times concurrently.
   *
   * `width` is how many. Each copy gets `{{index}}` substituted, so a panel can
   * vary without being N separate nodes — and a panel that does *not* vary is
   * exactly what decorrelate exists to complain about.
   */
  fanout?: { over: string; width: number; maxConcurrent?: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  channel?: string;
  barrier?: boolean;
  barrierReason?: string;
}

export interface WorkflowSpec {
  name: string;
  description?: string;
  /** Default working directory for nodes that do not name one. */
  cwd?: string;
  /** Refuse to start when preflight expects to exceed this. */
  budget?: { usd?: number | null; tokens?: number | null };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type NodeState = "pending" | "running" | "done" | "failed" | "skipped";

/** What happened to one node. One entry per fan-out child. */
export interface NodeRun {
  id: string;
  state: NodeState;
  /** Which copy, when the node fanned out. */
  index?: number;
  startedAt?: number;
  endedAt?: number;
  sessionId?: string;
  /** What the CLI itself reported for the turn. Measured, not estimated. */
  costUsd?: number;
  /** The model's final text. Also what `{{input}}` carries downstream. */
  output?: string;
  /** Why it failed, or which upstream node caused it to be skipped. */
  detail?: string;
}

export interface RunState {
  id: string;
  workflow: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "done" | "failed" | "refused";
  nodes: NodeRun[];
  /** Refusal reason, or the gate that stopped it. Empty while it is fine. */
  detail: string;
  /** Sum of what the CLI reported. Null while nothing priced has finished. */
  costUsd: number | null;
}

export type RunEvent =
  | { type: "run"; run: RunState }
  | { type: "node"; run: string; node: NodeRun };

/* ---------------------------------------------------------------------------
 * validation
 * ------------------------------------------------------------------------- */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface Invalid {
  /** Node or edge the problem belongs to, when it belongs to one. */
  where?: string;
  message: string;
}

/**
 * Everything that must be true before a token is spent.
 *
 * Returns every problem rather than the first: a workflow with three bad
 * directories should be fixed once, not three times.
 */
export function validate(spec: WorkflowSpec, ctx: ActionContext = {}): Invalid[] {
  const bad: Invalid[] = [];
  if (!spec || typeof spec !== "object") return [{ message: "not a workflow document" }];
  if (!spec.name || !ID_RE.test(spec.name)) {
    bad.push({ message: "name must be letters, digits, dot, dash or underscore" });
  }
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  if (!nodes.length) bad.push({ message: "a workflow with no nodes would run nothing" });

  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n?.id || !ID_RE.test(n.id)) {
      bad.push({ where: String(n?.id ?? "?"), message: "node id must be letters, digits, dot, dash or underscore" });
      continue;
    }
    if (seen.has(n.id)) bad.push({ where: n.id, message: "declared twice" });
    seen.add(n.id);

    const promptProblem = checkPrompt(n.prompt);
    if (promptProblem) bad.push({ where: n.id, message: promptProblem });

    const cwd = n.cwd ?? spec.cwd;
    if (!cwd) {
      bad.push({ where: n.id, message: "no working directory, and the workflow does not set one" });
    } else {
      // The same gate spawn uses. A workflow is a file on disk, and a file that
      // could name any directory would make --allow-root decorative.
      const cwdProblem = checkCwd(cwd, ctx);
      if (cwdProblem) bad.push({ where: n.id, message: cwdProblem });
    }

    if (n.fanout) {
      const w = n.fanout.width;
      if (!Number.isInteger(w) || w < 1 || w > 64) {
        bad.push({ where: n.id, message: "fan-out width must be a whole number from 1 to 64" });
      }
    }
  }

  for (const e of Array.isArray(spec.edges) ? spec.edges : []) {
    if (!seen.has(e?.from)) bad.push({ where: e?.from, message: `edge from unknown node "${e?.from}"` });
    if (!seen.has(e?.to)) bad.push({ where: e?.to, message: `edge to unknown node "${e?.to}"` });
    if (e?.from === e?.to) bad.push({ where: e.from, message: "an edge from a node to itself is a cycle of one" });
  }

  const cycle = findCycle(spec);
  if (cycle) {
    bad.push({
      where: cycle[0],
      // Named rather than counted: "there is a cycle" sends you looking, and
      // the path is the answer you were going to look for.
      message: `these nodes depend on each other in a loop: ${cycle.join(" → ")}`,
    });
  }
  return bad;
}

/** The first dependency cycle, as a path, or null. */
export function findCycle(spec: WorkflowSpec): string[] | null {
  const out = new Map<string, string[]>();
  for (const n of spec.nodes ?? []) out.set(n.id, []);
  for (const e of spec.edges ?? []) {
    if (out.has(e.from) && out.has(e.to)) out.get(e.from)!.push(e.to);
  }

  const state = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];

  const walk = (id: string): string[] | null => {
    state.set(id, 1);
    path.push(id);
    for (const next of out.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 1) return [...path.slice(path.indexOf(next)), next];
      if (s === 0) {
        const hit = walk(next);
        if (hit) return hit;
      }
    }
    path.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of out.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const hit = walk(id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Who each node waits for. */
export function dependencies(spec: WorkflowSpec): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const n of spec.nodes) deps.set(n.id, []);
  for (const e of spec.edges ?? []) {
    if (deps.has(e.to) && deps.has(e.from)) deps.get(e.to)!.push(e.from);
  }
  return deps;
}

/**
 * The spec as the family reads it.
 *
 * Execution fields are dropped, because neither graphlint nor preflight has an
 * opinion about a prompt's working directory, and a document with fields a tool
 * ignores is a document whose findings are harder to trust.
 */
export function familySpec(spec: WorkflowSpec) {
  return {
    name: spec.name,
    description: spec.description ?? "",
    budget: spec.budget ?? undefined,
    nodes: spec.nodes.map((n) => ({
      id: n.id,
      phase: n.phase,
      tier: n.tier,
      model: n.model,
      ...(n.fanout ? { fanout: { over: n.fanout.over, width: n.fanout.width } } : {}),
    })),
    edges: (spec.edges ?? []).map((e) => ({
      from: e.from,
      to: e.to,
      channel: e.channel,
      barrier: e.barrier,
      barrierReason: e.barrierReason,
    })),
    observed: {
      sessionId: "",
      fanouts: 0,
      widestFanout: 0,
      totalChildren: 0,
      failedChildren: 0,
      capturedAt: new Date(0).toISOString(),
    },
  };
}

/* ---------------------------------------------------------------------------
 * the gates
 * ------------------------------------------------------------------------- */

export interface Gate {
  ok: boolean;
  /** What the gate decided, in a sentence, whether or not it ran. */
  detail: string;
  /** True when the tool that would have judged this is not installed. */
  skipped: boolean;
}

/**
 * Lint the workflow before running it.
 *
 * An absent graphlint does not pass the gate — it *skips* it, and says so. The
 * difference matters more here than anywhere else in this repo: everywhere else
 * a false clean costs you a wrong number on a dashboard, and here it costs you
 * a fleet of agents doing the wrong thing.
 */
export async function lintGate(spec: WorkflowSpec, opts: FamilyOptions = {}): Promise<Gate> {
  const r = await lintObserved(familySpec(spec) as never, opts);
  if (!r.ok) return { ok: true, skipped: true, detail: `not linted — ${r.detail}` };
  if (r.summary.errors > 0) {
    const first = r.findings.find((f) => f.severity === "error");
    return {
      ok: false,
      skipped: false,
      detail: `graphlint found ${r.summary.errors} error(s): ${first?.rule} — ${first?.message}`,
    };
  }
  return { ok: true, skipped: false, detail: `graphlint: ${r.summary.warnings} warning(s), no errors` };
}

/** Price it before running it, against the budget the workflow declares. */
export async function budgetGate(spec: WorkflowSpec, opts: FamilyOptions = {}): Promise<Gate> {
  const cap = spec.budget?.usd;
  const r = await estimateObserved(familySpec(spec) as never, opts);
  if (!r.ok) return { ok: true, skipped: true, detail: `not priced — ${r.detail}` };
  const expected = r.usd?.expected;
  if (expected === undefined) return { ok: true, skipped: true, detail: "preflight returned no figure" };
  if (cap === undefined || cap === null) {
    return { ok: true, skipped: false, detail: `preflight expects $${expected.toFixed(2)}; no budget set` };
  }
  if (expected > cap) {
    return {
      ok: false,
      skipped: false,
      detail: `preflight expects $${expected.toFixed(2)}, over the $${cap.toFixed(2)} budget this workflow declares`,
    };
  }
  return { ok: true, skipped: false, detail: `preflight expects $${expected.toFixed(2)}, within $${cap.toFixed(2)}` };
}

/* ---------------------------------------------------------------------------
 * the runner
 * ------------------------------------------------------------------------- */

export interface RunOptions extends ActionContext {
  /** Nodes in flight at once, across the whole run. Default 4. */
  maxConcurrent?: number;
  /** Run even when a gate says no. The gates still report what they decided. */
  force?: boolean;
  /** Called on every state change, for streaming to a canvas. */
  onEvent?: (e: RunEvent) => void;
  /** Swappable for tests: runs one node and reports what happened. */
  execute?: (node: WorkflowNode, prompt: string, index: number) => Promise<NodeRun>;
  family?: FamilyOptions;
  /** Supplies the run id, so a caller can address the run it just started. */
  runId?: string;
}

/** Substitute what a node is given. Literal, so a prompt reads as what was sent. */
export function fillPrompt(template: string, input: string, index: number, width: number): string {
  return template
    .replace(/\{\{\s*input\s*\}\}/g, input)
    .replace(/\{\{\s*index\s*\}\}/g, String(index + 1))
    .replace(/\{\{\s*width\s*\}\}/g, String(width));
}

/** One headless Claude run. The default `execute`. */
async function runNode(
  node: WorkflowNode,
  prompt: string,
  index: number,
  spec: WorkflowSpec,
  opts: RunOptions,
): Promise<NodeRun> {
  const { runHeadless } = await import("./actions.js");
  const started = Date.now();
  const res = await runHeadless(
    {
      prompt,
      cwd: node.cwd ?? spec.cwd ?? "",
      model: node.model,
      effort: node.effort,
      agent: node.agent,
    },
    opts,
  );
  return {
    id: node.id,
    index: node.fanout ? index : undefined,
    state: res.ok ? "done" : "failed",
    startedAt: started,
    endedAt: Date.now(),
    sessionId: res.sessionId,
    costUsd: res.result?.total_cost_usd,
    output: res.result?.result,
    detail: res.ok ? "" : res.detail,
  };
}

/**
 * Run a workflow.
 *
 * Ready nodes start together up to the cap; each completion re-checks what that
 * unblocked. There is no scheduler cleverer than that here on purpose — the
 * shape of the graph is the schedule, and a runner that reordered work would be
 * running something other than the graph you linted.
 */
export async function runWorkflow(spec: WorkflowSpec, opts: RunOptions = {}): Promise<RunState> {
  const run: RunState = {
    id: opts.runId ?? `run-${Date.now().toString(36)}`,
    workflow: spec.name,
    startedAt: Date.now(),
    state: "running",
    nodes: [],
    detail: "",
    costUsd: null,
  };
  const emit = (e: RunEvent) => opts.onEvent?.(e);
  const finish = (state: RunState["state"], detail: string): RunState => {
    run.state = state;
    run.detail = detail;
    run.endedAt = Date.now();
    emit({ type: "run", run });
    return run;
  };

  const problems = validate(spec, opts);
  if (problems.length) {
    return finish(
      "refused",
      `this workflow will not run: ${problems.map((p) => (p.where ? `${p.where}: ${p.message}` : p.message)).join("; ")}`,
    );
  }

  // The gates. Both report what they decided even when they let the run past,
  // because "not linted" and "linted clean" must never look the same.
  const [lint, budget] = await Promise.all([
    lintGate(spec, opts.family),
    budgetGate(spec, opts.family),
  ]);
  const blocked = [lint, budget].filter((g) => !g.ok);
  if (blocked.length && !opts.force) {
    return finish("refused", `${blocked.map((g) => g.detail).join("; ")}. Run it with force to override.`);
  }
  run.detail = [lint.detail, budget.detail].filter(Boolean).join(" · ");
  emit({ type: "run", run });

  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const deps = dependencies(spec);
  const done = new Map<string, NodeRun[]>();
  const failed = new Set<string>();
  const skipped = new Map<string, string>();
  const remaining = new Set(spec.nodes.map((n) => n.id));
  const cap = Math.max(1, opts.maxConcurrent ?? 4);

  const record = (r: NodeRun) => {
    run.nodes.push(r);
    if (typeof r.costUsd === "number") run.costUsd = (run.costUsd ?? 0) + r.costUsd;
    emit({ type: "node", run: run.id, node: r });
  };

  /** A node runs when every dependency finished; it is skipped if any did not. */
  const readiness = (id: string): "ready" | "waiting" | { skip: string } => {
    for (const d of deps.get(id) ?? []) {
      if (failed.has(d)) return { skip: d };
      if (skipped.has(d)) return { skip: d };
      if (!done.has(d)) return "waiting";
    }
    return "ready";
  };

  const inFlight = new Set<Promise<void>>();

  while (remaining.size) {
    let started = 0;

    for (const id of [...remaining]) {
      if (inFlight.size >= cap) break;
      const state = readiness(id);
      if (state === "waiting") continue;

      remaining.delete(id);

      if (typeof state === "object") {
        // Skipped, and the run says which node did it. Never rolled up as done.
        skipped.set(id, state.skip);
        record({
          id,
          state: "skipped",
          detail: `not run: ${state.skip} did not succeed`,
        });
        started++;
        continue;
      }

      const node = byId.get(id)!;
      const input = (deps.get(id) ?? [])
        .flatMap((d) => done.get(d) ?? [])
        .map((r) => r.output ?? "")
        .filter(Boolean)
        .join("\n\n---\n\n");
      const width = node.fanout?.width ?? 1;

      const task = (async () => {
        const running: NodeRun = { id, state: "running", startedAt: Date.now() };
        emit({ type: "node", run: run.id, node: running });

        // A fan-out's children are the one place this runner is genuinely
        // parallel, and they are issued together, which is exactly what the
        // observed graph would later record about them.
        const results = await Promise.all(
          Array.from({ length: width }, (_, i) =>
            (opts.execute ?? ((n, p, k) => runNode(n, p, k, spec, opts)))(
              node,
              fillPrompt(node.prompt, input, i, width),
              i,
            ).catch(
              (e): NodeRun => ({
                id,
                index: node.fanout ? i : undefined,
                state: "failed",
                detail: (e as Error).message,
              }),
            ),
          ),
        );
        for (const r of results) record(r);
        // One failed child fails the node: downstream asked for this node's
        // output, and a partial panel is not the thing it asked for.
        if (results.some((r) => r.state === "failed")) failed.add(id);
        else done.set(id, results);
      })();

      const tracked = task.finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
      started++;
    }

    if (inFlight.size) {
      await Promise.race(inFlight);
      continue;
    }
    if (!started && remaining.size) {
      // Nothing ran and nothing is in flight: everything left is waiting on
      // something that will never arrive. validate() rules cycles out, so this
      // is a belt-and-braces refusal rather than an expected path.
      for (const id of remaining) {
        record({ id, state: "skipped", detail: "not run: nothing it depends on ever completed" });
      }
      break;
    }
  }

  await Promise.all([...inFlight]);

  const anyFailed = run.nodes.some((n) => n.state === "failed");
  const anySkipped = run.nodes.some((n) => n.state === "skipped");
  return finish(
    anyFailed ? "failed" : "done",
    anyFailed || anySkipped
      ? `${run.nodes.filter((n) => n.state === "failed").length} failed, ` +
          `${run.nodes.filter((n) => n.state === "skipped").length} skipped`
      : run.detail,
  );
}


/* ---------------------------------------------------------------------------
 * where workflows live
 *
 * `~/.localflow/workflows/<name>.graph.json`, one file per workflow, in the
 * family's own format. Plain files on purpose: a workflow you can read, diff
 * and commit is a workflow you can review, and the whole argument for linting a
 * graph before running it assumes the graph is a document rather than rows in
 * some database this tool owns.
 * ------------------------------------------------------------------------- */

export function workflowsDir(): string {
  return join(process.env.LOCALFLOW_HOME ?? join(homedir(), ".localflow"), "workflows");
}

export interface StoredWorkflow {
  name: string;
  path: string;
  updatedAt: number;
  spec?: WorkflowSpec;
  /** Set when the file is present but unusable. Shown, never swallowed. */
  error?: string;
}

/** Every workflow on disk, newest first. A missing directory is not an error. */
export function listWorkflows(dir = workflowsDir()): StoredWorkflow[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows: StoredWorkflow[] = [];
  for (const f of files) {
    const path = join(dir, f);
    const name = f.replace(/\.(graph\.)?json$/, "");
    try {
      const spec = JSON.parse(readFileSync(path, "utf8")) as WorkflowSpec;
      rows.push({ name, path, updatedAt: statMtime(path), spec });
    } catch (e) {
      // A broken file is named rather than hidden: a workflow that silently
      // vanished from the list is one you go looking for in the wrong place.
      rows.push({ name, path, updatedAt: statMtime(path), error: (e as Error).message });
    }
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function readWorkflow(name: string, dir = workflowsDir()): WorkflowSpec | null {
  if (!ID_RE.test(name)) return null;
  const path = join(dir, `${name}.graph.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkflowSpec;
  } catch {
    return null;
  }
}

/**
 * Write one.
 *
 * The name is checked against the same pattern as a node id and then used as
 * the filename directly — no path is ever taken from the caller, so there is
 * nothing for a `../` to do.
 */
export function saveWorkflow(spec: WorkflowSpec, dir = workflowsDir()): { ok: boolean; path?: string; detail: string } {
  if (!spec?.name || !ID_RE.test(spec.name)) {
    return { ok: false, detail: "name must be letters, digits, dot, dash or underscore" };
  }
  const path = join(dir, `${spec.name}.graph.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
    return { ok: true, path, detail: `saved to ${path}` };
  } catch (e) {
    return { ok: false, detail: `could not write ${path}: ${(e as Error).message}` };
  }
}
