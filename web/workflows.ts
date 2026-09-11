/**
 * The workflow editor: a chain of Claude prompts you compose, run, and watch.
 *
 * Three panes. On the left, what a step can be — a prompt, or any slash
 * command, skill or subagent that is actually installed on this machine. In
 * the middle, the chain, drawn left to right the way it will run: a step
 * after another is sequential, steps stacked in a column are parallel, a step
 * marked ×N is a fan-out panel. On the right, the step you clicked.
 *
 * The canvas has no stored coordinates. A step sits one column right of
 * everything it depends on, so the picture is derived from the edges and
 * cannot go stale — delete a step and the layout is still correct, which is not
 * true of any editor that remembers where you dropped things. What you can do
 * is what matters to the run: chain a step after another, put one alongside,
 * draw an edge from one output port to another step's input, and delete.
 *
 * A run is the same picture with the states painted on, and the same picture
 * again as one card on the board with the whole chain in it — so the job you
 * started before lunch is still there, as a chain, when you come back.
 */
import { $, age, el, money, shortModel, span, svg, tilde, toast } from "./dom.js";

/* ---------------------------------------------------------------------------
 * shapes, mirroring src/workflow.ts and src/commands.ts
 * ------------------------------------------------------------------------- */

export interface WfNode {
  id: string;
  label?: string;
  prompt: string;
  command?: string;
  args?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  agent?: string;
  phase?: string;
  tier?: string;
  fanout?: { over: string; width: number };
}

export interface WfEdge { from: string; to: string; channel?: string; barrier?: boolean; barrierReason?: string }

export interface WfSpec {
  name: string;
  description?: string;
  cwd?: string;
  budget?: { usd?: number | null; tokens?: number | null };
  concurrency?: number;
  nodes: WfNode[];
  edges: WfEdge[];
}

export type NodeState = "pending" | "running" | "done" | "failed" | "skipped";

export interface NodeRun {
  id: string;
  state: NodeState;
  index?: number;
  startedAt?: number;
  endedAt?: number;
  sessionId?: string;
  costUsd?: number;
  output?: string;
  detail?: string;
  hasOutput?: boolean;
}

export interface RunPlan {
  cwd?: string;
  nodes: { id: string; label: string; kind: "prompt" | "command" | "agent"; model?: string; agent?: string; command?: string; width: number }[];
  edges: { from: string; to: string }[];
}

export interface RunState {
  id: string;
  workflow: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "done" | "failed" | "refused";
  nodes: NodeRun[];
  detail: string;
  costUsd: number | null;
  plan?: RunPlan;
  restored?: boolean;
}

interface CatalogueItem {
  kind: "command" | "skill" | "agent";
  name: string;
  invoke: string;
  description: string;
  scope: "user" | "project" | "plugin";
  path: string;
  namespace?: string;
  argumentHint?: string;
  model?: string;
}

interface Catalogue {
  commands: CatalogueItem[];
  skills: CatalogueItem[];
  agents: CatalogueItem[];
  scanned: string[];
  unreadable: string[];
  cwdProblem?: string | null;
}

/** A thing the palette offers. Built-in blocks and catalogue entries share it. */
interface Step {
  kind: "prompt" | "panel" | "command" | "skill" | "agent";
  name: string;
  invoke?: string;
  description: string;
  scope?: string;
  model?: string;
  argumentHint?: string;
}

/** What the editor needs from the rest of the app. */
export interface Deps {
  board(): { tasks: { id: string; cwd: string }[]; runs?: RunState[] } | null;
  actionsEnabled(): boolean;
  setView(view: string): void;
  openSession(id: string): void;
  closeDrawer(): void;
}

let deps: Deps;

/* ---------------------------------------------------------------------------
 * state
 * ------------------------------------------------------------------------- */

let spec: WfSpec | null = null;
/** The name the file on disk has, so a rename can replace it rather than fork it. */
let savedName: string | null = null;
let selected: string | null = null;
let selectedEdge: { from: string; to: string } | null = null;
let dirty = false;
/** Problems the server reported for the current spec, by node id. */
let problems = new Map<string, string[]>();
/** The run whose states are painted onto the canvas. */
let overlay: RunState | null = null;
let runs: RunState[] = [];
let stream: EventSource | null = null;
let catalogue: Catalogue | null = null;
let catalogueFor: string | null = null;
let paletteQuery = "";
let list: { name: string; error?: string; spec?: WfSpec }[] = [];
let listDir = "";

const inWorkflows = () => document.body.dataset.view === "workflows";

/* ---------------------------------------------------------------------------
 * layout: longest path from a root, left to right
 * ------------------------------------------------------------------------- */

interface Graph { nodes: { id: string }[]; edges: { from: string; to: string }[] }

export function layers(g: Graph): string[][] {
  const deps_ = new Map<string, string[]>();
  for (const n of g.nodes) deps_.set(n.id, []);
  for (const e of g.edges ?? []) if (deps_.has(e.to) && deps_.has(e.from)) deps_.get(e.to)!.push(e.from);

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const of = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    // A cycle cannot be laid out, and the editor must survive one long enough
    // for you to fix it — validation is what refuses to *run* it.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = (deps_.get(id) ?? []).reduce((a, p) => Math.max(a, of(p) + 1), 0);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const cols: string[][] = [];
  for (const n of g.nodes) (cols[of(n.id)] ??= []).push(n.id);
  return cols.map((c) => c ?? []);
}

function wouldCycle(g: Graph, from: string, to: string): boolean {
  // Is `from` reachable from `to`? Then to → from closes a loop.
  const out = new Map<string, string[]>();
  for (const e of g.edges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(out.get(id) ?? []));
  }
  return false;
}

interface Geometry { w: number; h: number; gapX: number; gapY: number; pad: number }
const EDIT: Geometry = { w: 200, h: 66, gapX: 76, gapY: 24, pad: 32 };
const COMPACT: Geometry = { w: 132, h: 40, gapX: 40, gapY: 10, pad: 12 };

function layout(g: Graph, geo: Geometry, minWidth = 0, minHeight = 0) {
  const cols = layers(g);
  const tallest = Math.max(1, ...cols.map((c) => c.length));
  const width = Math.max(minWidth, geo.pad * 2 + cols.length * geo.w + Math.max(0, cols.length - 1) * geo.gapX);
  const height = Math.max(minHeight, geo.pad * 2 + tallest * geo.h + (tallest - 1) * geo.gapY);
  const at = new Map<string, { x: number; y: number }>();
  cols.forEach((col, c) => {
    const colH = col.length * geo.h + (col.length - 1) * geo.gapY;
    const y0 = (height - colH) / 2;
    col.forEach((id, i) => at.set(id, { x: geo.pad + c * (geo.w + geo.gapX), y: y0 + i * (geo.h + geo.gapY) }));
  });
  return { at, width, height, cols };
}

/* ---------------------------------------------------------------------------
 * run state, per node
 * ------------------------------------------------------------------------- */

/** One state for a node, collapsed from the row-per-child the runner emits. */
export function stateOf(run: RunState | null, id: string): NodeState | null {
  const rows = (run?.nodes ?? []).filter((n) => n.id === id);
  if (!rows.length) return run && run.state !== "running" ? null : run ? "pending" : null;
  if (rows.some((r) => r.state === "failed")) return "failed";
  if (rows.some((r) => r.state === "running")) return "running";
  if (rows.some((r) => r.state === "skipped")) return "skipped";
  return rows.every((r) => r.state === "done") ? "done" : "pending";
}

function costOf(run: RunState | null, id: string): number | null {
  const rows = (run?.nodes ?? []).filter((n) => n.id === id && typeof n.costUsd === "number");
  return rows.length ? rows.reduce((a, r) => a + (r.costUsd ?? 0), 0) : null;
}

const STATE_GLYPH: Record<NodeState, string> = { pending: "·", running: "▶", done: "✓", failed: "✗", skipped: "–" };

/* ---------------------------------------------------------------------------
 * the stage: one renderer for the editor, the drawer and (compactly) the card
 * ------------------------------------------------------------------------- */

interface StageNode {
  id: string;
  title: string;
  kind: "prompt" | "command" | "agent";
  meta: string;
  width: number;
  hint: string;
  bad?: string;
}

interface StageOptions {
  geo: Geometry;
  run: RunState | null;
  editable: boolean;
  minWidth?: number;
  minHeight?: number;
}

const KIND_GLYPH = { prompt: "¶", command: "/", agent: "@" } as const;

function stageNodes(s: WfSpec): StageNode[] {
  return s.nodes.map((n) => ({
    id: n.id,
    title: titleOf(n),
    kind: n.command ? "command" : n.agent ? "agent" : "prompt",
    meta: [n.model ? shortModel(n.model) : null, n.effort, n.agent ? `@${n.agent}` : null].filter(Boolean).join(" · "),
    width: n.fanout?.width ?? 1,
    hint: promptOf(n),
    bad: problems.get(n.id)?.join("; "),
  }));
}

function planNodes(p: RunPlan): StageNode[] {
  return p.nodes.map((n) => ({
    id: n.id,
    title: n.label,
    kind: n.kind,
    meta: [n.model ? shortModel(n.model) : null, n.agent ? `@${n.agent}` : null].filter(Boolean).join(" · "),
    width: n.width,
    hint: n.label,
  }));
}

export function titleOf(n: WfNode): string {
  if (n.label?.trim()) return n.label.trim();
  if (n.command) return n.command.startsWith("/") ? n.command : `/${n.command}`;
  const line = (n.prompt ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? n.id;
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** What the node sends. The same rule the runner applies, so the hint is what will be sent. */
function promptOf(n: WfNode): string {
  if (n.command) return `${n.command.startsWith("/") ? n.command : `/${n.command}`} ${n.args ?? ""}`.trim();
  return n.prompt ?? "";
}

function renderStage(nodes: StageNode[], edges: { from: string; to: string }[], o: StageOptions): HTMLElement {
  const g = { nodes, edges };
  const { at, width, height } = layout(g, o.geo, o.minWidth, o.minHeight);
  const stage = el("div", { class: `wf-stage${o.editable ? " editable" : " readonly"}` });
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;

  const lines = svg("svg", { class: "wf-lines", width, height });
  const defs = svg("defs");
  const mk = (id: string, cls: string) => {
    const m = svg("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" });
    m.append(svg("path", { d: "M 0 1 L 7 4 L 0 7 z", class: cls }));
    defs.append(m);
  };
  mk("wf-arrow", "wf-arrow");
  mk("wf-arrow-sel", "wf-arrow sel");
  lines.append(defs);

  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    const isSel = o.editable && selectedEdge?.from === e.from && selectedEdge?.to === e.to;
    const x1 = a.x + o.geo.w;
    const y1 = a.y + o.geo.h / 2;
    const x2 = b.x;
    const y2 = b.y + o.geo.h / 2;
    const dx = Math.max(24, (x2 - x1) / 2);
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    const upstream = stateOf(o.run, e.from);
    const cls = `wf-edge${isSel ? " sel" : ""}${upstream === "done" ? " flowed" : ""}`;
    // A wide invisible twin makes a hairline clickable.
    if (o.editable) {
      const hit = svg("path", { class: "wf-edge-hit", d });
      hit.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selectedEdge = { from: e.from, to: e.to };
        selected = null;
        renderBody();
      });
      lines.append(hit);
    }
    lines.append(svg("path", { class: cls, d, "marker-end": `url(#${isSel ? "wf-arrow-sel" : "wf-arrow"})` }));
    if (isSel) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const cut = el("button", { class: "wf-edge-cut", title: "remove this dependency (Delete)" }, "×");
      cut.style.left = `${mx}px`;
      cut.style.top = `${my}px`;
      cut.addEventListener("click", (ev) => {
        ev.stopPropagation();
        disconnect(e.from, e.to);
      });
      stage.append(cut);
    }
  }
  stage.prepend(lines);

  for (const n of nodes) {
    const p = at.get(n.id);
    if (!p) continue;
    const state = stateOf(o.run, n.id);
    const node = el("div", {
      class: [
        "wf-node",
        `kind-${n.kind}`,
        state ? `state-${state}` : "",
        o.editable && selected === n.id ? "sel" : "",
        n.bad ? "bad" : "",
      ].filter(Boolean).join(" "),
      tabIndex: o.editable ? 0 : -1,
      title: n.bad ? `${n.bad}\n\n${n.hint}` : n.hint,
    });
    node.dataset.id = n.id;
    node.style.left = `${p.x}px`;
    node.style.top = `${p.y}px`;
    node.style.width = `${o.geo.w}px`;
    node.style.height = `${o.geo.h}px`;

    const head = el("div", { class: "wf-node-head" }, el("span", { class: "glyph" }, KIND_GLYPH[n.kind]), el("span", { class: "title" }, n.title));
    if (n.width > 1) head.append(el("span", { class: "width", title: `runs ${n.width} copies in parallel` }, `×${n.width}`));
    node.append(head);
    if (o.geo === EDIT) {
      const meta = el("div", { class: "wf-node-meta" }, n.meta || "default model");
      node.append(meta);
      const cost = costOf(o.run, n.id);
      if (state) {
        const st = el("div", { class: `wf-node-state ${state}` }, `${STATE_GLYPH[state]} ${state}`);
        if (cost !== null) st.append(el("span", {}, ` · ${money(cost)}`));
        node.append(st);
      }
    } else if (state) {
      node.append(el("span", { class: `wf-node-dot ${state}`, title: state }));
    }

    if (o.editable) {
      node.append(el("span", { class: "port in", title: "input — drag an output port here to make this step wait for it" }));
      const out = el("span", { class: "port out", title: "output — drag to another step to feed it" });
      out.addEventListener("pointerdown", (ev) => startConnect(ev, n.id, stage, p, o.geo));
      node.append(out);

      const then = el("button", { class: "wf-add then", title: "add a step after this one (runs when it finishes)" }, "+");
      then.addEventListener("click", (ev) => {
        ev.stopPropagation();
        addStep(PROMPT_STEP, n.id, "after");
      });
      const beside = el("button", { class: "wf-add beside", title: "add a step alongside (runs in parallel with it)" }, "+");
      beside.addEventListener("click", (ev) => {
        ev.stopPropagation();
        addStep(PROMPT_STEP, n.id, "beside");
      });
      node.append(then, beside);

      // Drop zones for palette chips. Only visible mid-drag, so a node reads
      // as a node the rest of the time.
      for (const mode of ["after", "beside"] as const) {
        const dz = el("div", { class: `dz ${mode}` }, mode === "after" ? "then" : "alongside");
        dz.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          dz.classList.add("over");
        });
        dz.addEventListener("dragleave", () => dz.classList.remove("over"));
        dz.addEventListener("drop", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const step = draggedStep(ev);
          if (step) addStep(step, n.id, mode);
        });
        node.append(dz);
      }

      node.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selected = n.id;
        selectedEdge = null;
        renderBody();
      });
    }
    stage.append(node);
  }
  return stage;
}

/* ---- connecting by dragging a port ---------------------------------------- */

function startConnect(ev: PointerEvent, from: string, stage: HTMLElement, p: { x: number; y: number }, geo: Geometry): void {
  ev.preventDefault();
  ev.stopPropagation();
  const lines = stage.querySelector<SVGSVGElement>(".wf-lines")!;
  const temp = svg("path", { class: "wf-edge temp" });
  lines.append(temp);
  const x1 = p.x + geo.w;
  const y1 = p.y + geo.h / 2;
  const rect = () => stage.getBoundingClientRect();
  document.body.classList.add("wf-connecting");

  const move = (m: PointerEvent) => {
    const r = rect();
    const x2 = m.clientX - r.left;
    const y2 = m.clientY - r.top;
    const dx = Math.max(24, Math.abs(x2 - x1) / 2);
    temp.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
    stage.querySelectorAll(".wf-node.target").forEach((n) => n.classList.remove("target"));
    const over = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>(".wf-node");
    if (over && over.dataset.id !== from) over.classList.add("target");
  };
  const up = (m: PointerEvent) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.body.classList.remove("wf-connecting");
    temp.remove();
    const over = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>(".wf-node");
    if (over?.dataset.id && over.dataset.id !== from) connect(from, over.dataset.id);
    else renderBody();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

/* ---------------------------------------------------------------------------
 * editing
 * ------------------------------------------------------------------------- */

const PROMPT_STEP: Step = { kind: "prompt", name: "Prompt", description: "A plain instruction. Use {{input}} to hand it what the steps before it produced." };
const PANEL_STEP: Step = { kind: "panel", name: "Fan-out panel", description: "The same prompt, N copies at once. {{index}} of {{width}} tells each copy which one it is." };

function markDirty(): void {
  dirty = true;
  renderBar();
}

function uniqueId(base: string): string {
  const stem = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "step";
  if (!spec!.nodes.some((n) => n.id === stem)) return stem;
  for (let i = 2; ; i++) if (!spec!.nodes.some((n) => n.id === `${stem}-${i}`)) return `${stem}-${i}`;
}

function nodeFrom(step: Step): WfNode {
  switch (step.kind) {
    case "command":
    case "skill":
      return { id: uniqueId(step.name), prompt: "", command: step.invoke ?? `/${step.name}`, args: "{{input}}", model: step.model };
    case "agent":
      return { id: uniqueId(step.name), prompt: "{{input}}", agent: step.name, label: `@${step.name}`, model: step.model };
    case "panel":
      return { id: uniqueId("panel"), prompt: "Given:\n{{input}}\n\nYou are reviewer {{index}} of {{width}}. Find one problem the others would miss.", fanout: { over: "agents", width: 3 } };
    default:
      return { id: uniqueId("step"), prompt: "" };
  }
}

/**
 * Add a step.
 *
 * `after` chains it: an edge from the target. `beside` puts it in parallel:
 * the same parents as the target, so it starts when the target would. `root`
 * is a new starting point. In every case the new step is selected, because
 * the next thing you do to a step you just added is write its prompt.
 */
function addStep(step: Step, target: string | null, mode: "after" | "beside" | "root"): void {
  if (!spec) startNew("blank");
  const s = spec!;
  const n = nodeFrom(step);
  s.nodes.push(n);
  if (target && mode === "after") {
    s.edges.push({ from: target, to: n.id });
  } else if (target && mode === "beside") {
    for (const e of s.edges.filter((e) => e.to === target)) s.edges.push({ from: e.from, to: n.id });
  }
  selected = n.id;
  selectedEdge = null;
  markDirty();
  renderBody();
  const prompt = $("#wf-inspect")?.querySelector<HTMLTextAreaElement>("textarea");
  prompt?.focus();
}

function connect(from: string, to: string): void {
  if (!spec || from === to) return renderBody();
  if (spec.edges.some((e) => e.from === from && e.to === to)) return renderBody();
  if (wouldCycle(spec, from, to)) {
    toast(`${to} already runs before ${from} — that edge would be a loop, and a loop never finishes.`, "err");
    return renderBody();
  }
  spec.edges.push({ from, to });
  selectedEdge = { from, to };
  selected = null;
  markDirty();
  renderBody();
}

function disconnect(from: string, to: string): void {
  if (!spec) return;
  spec.edges = spec.edges.filter((e) => !(e.from === from && e.to === to));
  selectedEdge = null;
  markDirty();
  renderBody();
}

function removeNode(id: string): void {
  if (!spec) return;
  // Bridge over it: what depended on this step now depends on what it
  // depended on, so deleting the middle of a chain leaves a chain.
  const ins = spec.edges.filter((e) => e.to === id).map((e) => e.from);
  const outs = spec.edges.filter((e) => e.from === id).map((e) => e.to);
  spec.nodes = spec.nodes.filter((n) => n.id !== id);
  spec.edges = spec.edges.filter((e) => e.from !== id && e.to !== id);
  for (const a of ins) for (const b of outs) if (!spec.edges.some((e) => e.from === a && e.to === b)) spec.edges.push({ from: a, to: b });
  if (selected === id) selected = ins[0] ?? outs[0] ?? spec.nodes[0]?.id ?? null;
  markDirty();
  renderBody();
}

function renameNode(n: WfNode, id: string): void {
  if (!spec || !id || id === n.id || spec.nodes.some((x) => x.id === id)) return;
  for (const e of spec.edges) {
    if (e.from === n.id) e.from = id;
    if (e.to === n.id) e.to = id;
  }
  n.id = id;
  selected = id;
}

/* ---- templates ------------------------------------------------------------ */

type Template = "blank" | "chain" | "panel" | "parallel";

const TEMPLATES: { key: Template; name: string; blurb: string }[] = [
  { key: "blank", name: "Blank", blurb: "Start from nothing." },
  { key: "chain", name: "Scope → build → review", blurb: "Three steps, each fed the one before." },
  { key: "panel", name: "Fan-out review", blurb: "One scoping step, a panel of three reviewers, a write-up." },
  { key: "parallel", name: "Parallel then merge", blurb: "Two steps side by side, then one that reads both." },
];

function startNew(t: Template): void {
  const name = `workflow-${Math.random().toString(36).slice(2, 6)}`;
  const base: WfSpec = { name, description: "", cwd: spec?.cwd ?? "", nodes: [], edges: [] };
  const P = (id: string, label: string, prompt: string, extra: Partial<WfNode> = {}): WfNode => ({ id, label, prompt, ...extra });
  switch (t) {
    case "chain":
      base.nodes = [
        P("scope", "Scope the work", "Read the codebase and list, in order, what needs to change to: <describe the goal>."),
        P("build", "Build it", "Do exactly this, and nothing beyond it:\n\n{{input}}"),
        P("review", "Review against the plan", "Review the change just made against this plan and list anything missing:\n\n{{input}}"),
      ];
      base.edges = [{ from: "scope", to: "build" }, { from: "build", to: "review" }];
      break;
    case "panel":
      base.nodes = [
        P("scope", "Map the routes", "List every route in this service and what authorises it.", { model: "sonnet" }),
        P("verify", "Review panel", "Given:\n{{input}}\n\nLens {{index}} of {{width}}: find one authorisation gap the others would miss.", { model: "opus", fanout: { over: "agents", width: 3 } }),
        P("report", "Write it up", "Write the findings up as a PR description:\n\n{{input}}"),
      ];
      base.edges = [
        { from: "scope", to: "verify", barrier: true, barrierReason: "the panel needs the route list" },
        { from: "verify", to: "report", barrier: true, barrierReason: "the write-up waits for every lens" },
      ];
      break;
    case "parallel":
      base.nodes = [
        P("tests", "Run the tests", "Run the test suite and summarise every failure with the file and line."),
        P("lint", "Run the linter", "Run the linter and summarise every error."),
        P("fix", "Fix what both found", "Fix everything below, smallest change first:\n\n{{input}}"),
      ];
      base.edges = [{ from: "tests", to: "fix" }, { from: "lint", to: "fix" }];
      break;
    default:
      break;
  }
  spec = base;
  savedName = null;
  selected = base.nodes[0]?.id ?? null;
  selectedEdge = null;
  overlay = null;
  problems = new Map();
  dirty = true;
  renderAll();
}

/* ---------------------------------------------------------------------------
 * palette
 * ------------------------------------------------------------------------- */

const DRAG_TYPE = "application/x-localflow-step";

function draggedStep(ev: DragEvent): Step | null {
  try {
    const raw = ev.dataTransfer?.getData(DRAG_TYPE);
    return raw ? (JSON.parse(raw) as Step) : null;
  } catch {
    return null;
  }
}

async function loadCatalogue(): Promise<void> {
  const cwd = spec?.cwd?.trim() || "";
  if (catalogue && catalogueFor === cwd) return;
  try {
    const r = await fetch(`/api/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
    catalogue = (await r.json()) as Catalogue;
    catalogueFor = cwd;
  } catch (e) {
    catalogue = { commands: [], skills: [], agents: [], scanned: [], unreadable: [String(e)] };
  }
  renderPalette();
}

function chip(step: Step): HTMLElement {
  const c = el("button", { class: `wf-chip kind-${step.kind}`, draggable: true, title: step.description || step.name });
  c.append(el("span", { class: "glyph" }, step.kind === "agent" ? "@" : step.kind === "prompt" || step.kind === "panel" ? "¶" : "/"));
  c.append(el("span", { class: "name" }, step.invoke ?? step.name));
  if (step.scope && step.scope !== "user") c.append(el("span", { class: "scope" }, step.scope));
  c.addEventListener("dragstart", (ev) => {
    ev.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(step));
    ev.dataTransfer?.setData("text/plain", step.invoke ?? step.name);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "copy";
    document.body.classList.add("wf-dragging");
  });
  c.addEventListener("dragend", () => document.body.classList.remove("wf-dragging"));
  c.addEventListener("click", () => addStep(step, selected, selected ? "after" : "root"));
  return c;
}

function renderPalette(): void {
  const host = $("#wf-palette");
  if (!host) return;
  host.textContent = "";
  const q = paletteQuery.trim().toLowerCase();
  const matches = (s: Step) => !q || `${s.name} ${s.invoke ?? ""} ${s.description}`.toLowerCase().includes(q);

  const section = (title: string, steps: Step[], empty: string) => {
    const sec = el("div", { class: "wf-pal-sec" }, el("h4", {}, title));
    const shown = steps.filter(matches);
    if (!shown.length) sec.append(el("p", { class: "blurb" }, empty));
    const row = el("div", { class: "wf-chips" });
    for (const s of shown) row.append(chip(s));
    sec.append(row);
    host.append(sec);
  };

  section("Blocks", [PROMPT_STEP, PANEL_STEP], "");
  const toStep = (i: CatalogueItem): Step => ({
    kind: i.kind, name: i.namespace ? `${i.namespace}:${i.name}` : i.name, invoke: i.invoke, description: i.description,
    scope: i.scope, model: i.model, argumentHint: i.argumentHint,
  });
  if (!catalogue) {
    host.append(el("p", { class: "blurb" }, "reading what is installed…"));
    return;
  }
  section("Slash commands", catalogue.commands.map(toStep), "No command files found. They live in ~/.claude/commands or <project>/.claude/commands.");
  section("Skills", catalogue.skills.map(toStep), "No skills found under ~/.claude/skills.");
  section("Agents", catalogue.agents.map(toStep), "No subagent files found under ~/.claude/agents.");

  const notes: string[] = [];
  if (catalogue.cwdProblem) notes.push(`project commands not read: ${catalogue.cwdProblem}`);
  if (catalogue.unreadable.length) notes.push(`${catalogue.unreadable.length} file(s) would not read`);
  notes.push("Built-in CLI commands are not listed — nothing on disk says which ones this version has. Type one into a Command step by hand.");
  host.append(el("p", { class: "blurb" }, notes.join(" · ")));
}

/* ---------------------------------------------------------------------------
 * rendering
 * ------------------------------------------------------------------------- */

function renderAll(): void {
  renderList();
  renderBar();
  renderBody();
  renderRunsStrip();
  void loadCatalogue();
}

function renderBody(): void {
  renderCanvas();
  renderInspector();
}

function renderBar(): void {
  const name = $("#wf-name") as HTMLInputElement;
  if (!name) return;
  name.value = spec?.name ?? "";
  name.disabled = !spec;
  $("#wf-dirty").hidden = !dirty;
  for (const id of ["#wf-check", "#wf-save", "#wf-run", "#wf-more"]) ($(id) as HTMLButtonElement).disabled = !spec;
  renderStatus();
}

function renderStatus(): void {
  const host = $("#wf-status");
  if (!host) return;
  const r = overlay;
  if (!r) {
    host.textContent = "";
    host.className = "wf-status";
    return;
  }
  const done = r.nodes.filter((n) => n.state === "done").length;
  const total = r.plan?.nodes.reduce((a, n) => a + n.width, 0) ?? r.nodes.length;
  host.textContent = [r.state, `${done}/${total} done`, r.costUsd === null ? null : money(r.costUsd)].filter(Boolean).join(" · ");
  host.className = `wf-status ${r.state}`;
  host.title = r.detail;
}

function renderList(): void {
  const items = $("#wf-items");
  if (!items) return;
  items.textContent = "";
  if (!list.length) items.append(el("p", { class: "blurb" }, "None yet — start one below, or drop a step on the canvas."));
  for (const w of list) {
    const row = el("button", { class: `wf-item${spec?.name === w.name || savedName === w.name ? " on" : ""}` });
    row.append(el("span", { class: "wf-item-name" }, w.name));
    const latest = runs.find((r) => r.workflow === w.name);
    if (w.error) row.append(el("span", { class: "wf-item-bad" }, "unreadable"));
    else row.append(el("span", { class: `wf-item-n${latest ? ` ${latest.state}` : ""}` }, latest ? `${latest.state} ${age(latest.endedAt ?? latest.startedAt)}` : `${w.spec?.nodes.length ?? 0} steps`));
    row.addEventListener("click", () => void openWorkflow(w.name));
    items.append(row);
  }
  $("#wf-dir").textContent = listDir ? `Files in ${tilde(listDir)} — plain graph specs, diffable and reviewable.` : "";
}

function renderCanvas(): void {
  const canvas = $("#wf-canvas");
  if (!canvas) return;
  canvas.textContent = "";
  if (!spec) {
    const empty = el("div", { class: "wf-empty" }, el("h3", {}, "Chain some prompts."), el("p", {}, "Pick a starting shape, or drag a step from the left onto this canvas."));
    const row = el("div", { class: "wf-templates" });
    for (const t of TEMPLATES) {
      const b = el("button", { class: "wf-template" }, el("b", {}, t.name), el("span", {}, t.blurb));
      b.addEventListener("click", () => startNew(t.key));
      row.append(b);
    }
    empty.append(row);
    canvas.append(empty);
    return;
  }
  const edges = spec.edges.map((e) => ({ from: e.from, to: e.to }));
  const stage = renderStage(stageNodes(spec), edges, {
    geo: EDIT, run: overlay, editable: true,
    minWidth: canvas.clientWidth - 2, minHeight: canvas.clientHeight - 2,
  });
  if (!spec.nodes.length) {
    stage.append(el("div", { class: "wf-empty small" }, el("p", {}, "Empty. Click a step on the left, or drop one here.")));
  }
  stage.addEventListener("click", () => {
    selected = null;
    selectedEdge = null;
    renderBody();
  });
  stage.addEventListener("dragover", (ev) => {
    if (ev.dataTransfer?.types.includes(DRAG_TYPE)) {
      ev.preventDefault();
      stage.classList.add("over");
    }
  });
  stage.addEventListener("dragleave", () => stage.classList.remove("over"));
  stage.addEventListener("drop", (ev) => {
    ev.preventDefault();
    stage.classList.remove("over");
    const step = draggedStep(ev);
    if (step) addStep(step, null, "root");
  });
  canvas.append(stage);
}

/* ---- inspector ------------------------------------------------------------ */

function field(host: HTMLElement, label: string, input: HTMLElement, hint?: string): void {
  const wrap = el("label", { class: "wf-field" }, el("span", {}, label), input);
  if (hint) wrap.append(el("small", {}, hint));
  host.append(wrap);
}

function text(value: string, onInput: (v: string) => void, opts: { area?: boolean; rows?: number; placeholder?: string; list?: string; mono?: boolean } = {}): HTMLInputElement | HTMLTextAreaElement {
  const input = opts.area ? document.createElement("textarea") : document.createElement("input");
  if (opts.area) (input as HTMLTextAreaElement).rows = opts.rows ?? 6;
  if (opts.list) (input as HTMLInputElement).setAttribute("list", opts.list);
  if (opts.placeholder) input.placeholder = opts.placeholder;
  if (opts.mono) input.classList.add("mono");
  input.value = value;
  input.addEventListener("input", () => {
    onInput(input.value);
    markDirty();
  });
  input.addEventListener("change", () => renderCanvas());
  return input;
}

function select(value: string, options: [string, string][], onChange: (v: string) => void): HTMLSelectElement {
  const s = document.createElement("select");
  for (const [v, label] of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    o.selected = v === value;
    s.append(o);
  }
  s.addEventListener("change", () => {
    onChange(s.value);
    markDirty();
    renderCanvas();
  });
  return s;
}

const MODELS: [string, string][] = [["", "default"], ["haiku", "haiku"], ["sonnet", "sonnet"], ["opus", "opus"], ["fable", "fable"]];
const EFFORTS: [string, string][] = [["", "default"], ["low", "low"], ["medium", "medium"], ["high", "high"]];

function cwdList(): HTMLDataListElement {
  const dl = document.createElement("datalist");
  dl.id = "wf-cwds";
  const seen = new Set<string>();
  if (spec?.cwd) seen.add(spec.cwd);
  for (const t of deps.board()?.tasks ?? []) if (t.cwd) seen.add(t.cwd);
  for (const c of seen) dl.append(el("option", { value: c }));
  return dl;
}

function renderInspector(): void {
  const host = $("#wf-inspect");
  if (!host) return;
  host.textContent = "";
  if (!spec) {
    host.append(el("p", { class: "blurb" }, "Nothing open. Pick a workflow on the left, or start one."));
    return;
  }
  const n = spec.nodes.find((x) => x.id === selected);
  if (!n) return renderWorkflowInspector(host);

  host.append(el("h4", {}, `step · ${n.id}`));

  const kind = n.command !== undefined ? "command" : "prompt";
  const kinds = el("div", { class: "wf-seg" });
  for (const [k, label] of [["prompt", "Prompt"], ["command", "Slash command"]] as const) {
    const b = el("button", { class: `wf-seg-btn${kind === k ? " on" : ""}` }, label);
    b.addEventListener("click", () => {
      if (k === "command") {
        n.command = n.command ?? "";
        n.args = n.args ?? (n.prompt || "{{input}}");
      } else {
        if (n.args && !n.prompt) n.prompt = n.args;
        delete n.command;
        delete n.args;
      }
      markDirty();
      renderBody();
    });
    kinds.append(b);
  }
  host.append(kinds);

  field(host, "title", text(n.label ?? "", (v) => (n.label = v || undefined), { placeholder: titleOf(n) }), "Shown on the canvas and the card. Optional.");

  if (kind === "command") {
    const dl = document.createElement("datalist");
    dl.id = "wf-commands";
    for (const c of [...(catalogue?.commands ?? []), ...(catalogue?.skills ?? [])]) {
      const o = el("option", { value: c.invoke });
      o.label = c.description;
      dl.append(o);
    }
    host.append(dl);
    field(host, "command", text(n.command ?? "", (v) => (n.command = v.trim()), { placeholder: "/review", list: "wf-commands", mono: true }), "Any installed command or skill. Built-ins work too if the CLI has them.");
    const args = text(n.args ?? "", (v) => (n.args = v), { area: true, rows: 5, placeholder: "{{input}}", mono: true });
    field(host, "arguments", args, "Sent after the command. {{input}} is what the steps before it produced.");
    host.append(insertRow(args as HTMLTextAreaElement, ["{{input}}", "{{index}}", "{{width}}"]));
  } else {
    const prompt = text(n.prompt ?? "", (v) => (n.prompt = v), { area: true, rows: 9, placeholder: "What should this step do?" });
    field(host, "prompt", prompt, "{{input}} is replaced by the output of every step this one waits for, joined with a rule between them.");
    host.append(insertRow(prompt as HTMLTextAreaElement, ["{{input}}", "{{index}}", "{{width}}"]));
  }

  const agents: [string, string][] = [["", "no — a plain session"], ...(catalogue?.agents ?? []).map((a): [string, string] => [a.name, `@${a.name}`])];
  if (n.agent && !agents.some(([v]) => v === n.agent)) agents.push([n.agent, `@${n.agent} (not found on disk)`]);
  field(host, "run as subagent", select(n.agent ?? "", agents, (v) => (n.agent = v || undefined)), "Passed as --agent. The step then runs with that agent's tools and system prompt.");

  const row = el("div", { class: "wf-row" });
  const m = el("label", { class: "wf-field" }, el("span", {}, "model"), select(n.model ?? "", n.model && !MODELS.some(([v]) => v === n.model) ? [...MODELS, [n.model, n.model]] : MODELS, (v) => (n.model = v || undefined)));
  const e = el("label", { class: "wf-field" }, el("span", {}, "effort"), select(n.effort ?? "", EFFORTS, (v) => (n.effort = v || undefined)));
  row.append(m, e);
  host.append(row);

  const row2 = el("div", { class: "wf-row" });
  const width = document.createElement("input");
  width.type = "number";
  width.min = "1";
  width.max = "64";
  width.value = String(n.fanout?.width ?? 1);
  width.addEventListener("input", () => {
    const w = Math.max(1, Math.min(64, Number(width.value) || 1));
    n.fanout = w > 1 ? { over: "agents", width: w } : undefined;
    markDirty();
    renderCanvas();
  });
  row2.append(el("label", { class: "wf-field" }, el("span", {}, "copies in parallel"), width));
  const id = text(n.id, () => undefined, { mono: true });
  id.addEventListener("change", () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id.value)) {
      toast("a step id is letters, digits, dot, dash or underscore", "err");
      id.value = n.id;
      return;
    }
    renameNode(n, id.value);
    renderBody();
  });
  row2.append(el("label", { class: "wf-field" }, el("span", {}, "id"), id));
  host.append(row2);

  host.append(cwdList());
  field(host, "working directory", text(n.cwd ?? "", (v) => (n.cwd = v || undefined), { placeholder: spec.cwd || "inherits the workflow's", list: "wf-cwds", mono: true }));

  // Dependencies, as chips: what this step waits for, and a picker to add one.
  const after = el("div", { class: "wf-field" }, el("span", {}, "waits for"));
  const chips = el("div", { class: "wf-deps" });
  const parents = spec.edges.filter((e) => e.to === n.id).map((e) => e.from);
  if (!parents.length) chips.append(el("span", { class: "blurb" }, "nothing — it starts first"));
  for (const p of parents) {
    const c = el("span", { class: "wf-dep" }, p);
    const x = el("button", { title: "remove" }, "×");
    x.addEventListener("click", () => disconnect(p, n.id));
    c.append(x);
    chips.append(c);
  }
  const others = spec.nodes.filter((x) => x.id !== n.id && !parents.includes(x.id));
  if (others.length) {
    const pick = select("", [["", "+ add…"], ...others.map((x): [string, string] => [x.id, titleOf(x)])], (v) => {
      if (v) connect(v, n.id);
    });
    chips.append(pick);
  }
  after.append(chips);
  host.append(after);

  const bad = problems.get(n.id);
  if (bad?.length) host.append(el("div", { class: "wf-problem" }, bad.join(" · ")));

  const actions = el("div", { class: "wf-actions" });
  const then = el("button", { class: "btn btn-quiet" }, "+ step after");
  then.addEventListener("click", () => addStep(PROMPT_STEP, n.id, "after"));
  const beside = el("button", { class: "btn btn-quiet" }, "+ step alongside");
  beside.addEventListener("click", () => addStep(PROMPT_STEP, n.id, "beside"));
  const del = el("button", { class: "btn btn-quiet danger" }, "delete");
  del.addEventListener("click", () => removeNode(n.id));
  actions.append(then, beside, del);
  host.append(actions);

  renderNodeRun(host, n.id);
}

function insertRow(area: HTMLTextAreaElement, tokens_: string[]): HTMLElement {
  const row = el("div", { class: "wf-inserts" }, el("span", {}, "insert"));
  for (const t of tokens_) {
    const b = el("button", { class: "btn btn-quiet", type: "button" }, t);
    b.addEventListener("click", () => {
      const a = area.selectionStart ?? area.value.length;
      const z = area.selectionEnd ?? a;
      area.value = area.value.slice(0, a) + t + area.value.slice(z);
      area.selectionStart = area.selectionEnd = a + t.length;
      area.dispatchEvent(new Event("input"));
      area.focus();
    });
    row.append(b);
  }
  return row;
}

function renderWorkflowInspector(host: HTMLElement): void {
  const s = spec!;
  host.append(el("h4", {}, "workflow"));
  field(host, "description", text(s.description ?? "", (v) => (s.description = v), { area: true, rows: 3, placeholder: "What this chain is for." }));
  host.append(cwdList());
  const cwd = text(s.cwd ?? "", (v) => (s.cwd = v), { placeholder: "~/dev/project", list: "wf-cwds", mono: true });
  cwd.addEventListener("change", () => void loadCatalogue());
  field(host, "working directory", cwd, "Where every step runs unless it names its own. Must be inside an allowed root when the server sets them.");

  const row = el("div", { class: "wf-row" });
  const budget = document.createElement("input");
  budget.type = "number";
  budget.min = "0";
  budget.step = "0.5";
  budget.placeholder = "none";
  budget.value = s.budget?.usd != null ? String(s.budget.usd) : "";
  budget.addEventListener("input", () => {
    const v = budget.value === "" ? null : Number(budget.value);
    s.budget = v === null ? undefined : { usd: v };
    markDirty();
  });
  row.append(el("label", { class: "wf-field" }, el("span", {}, "budget, USD"), budget));
  const conc = document.createElement("input");
  conc.type = "number";
  conc.min = "1";
  conc.max = "32";
  conc.placeholder = "4";
  conc.value = s.concurrency ? String(s.concurrency) : "";
  conc.addEventListener("input", () => {
    s.concurrency = conc.value ? Math.max(1, Number(conc.value)) : undefined;
    markDirty();
  });
  row.append(el("label", { class: "wf-field" }, el("span", {}, "steps at once"), conc));
  host.append(row);

  host.append(el("p", { class: "hint" }, "Click a step to edit it. Drag from a step's right-hand port to another step to make that one wait for it. Delete removes the selected step or edge."));

  const general = problems.get("");
  if (general?.length) host.append(el("div", { class: "wf-problem" }, general.join(" · ")));

  if (selectedEdge) {
    const e = selectedEdge;
    const sec = el("div", { class: "wf-runinfo" }, el("h4", {}, "edge"));
    sec.append(el("p", { class: "hint" }, `${e.to} waits for ${e.from} and receives its output as {{input}}.`));
    const cut = el("button", { class: "btn btn-quiet danger" }, "remove edge");
    cut.addEventListener("click", () => disconnect(e.from, e.to));
    sec.append(cut);
    host.append(sec);
  }
}

function renderNodeRun(host: HTMLElement, id: string): void {
  const rows = (overlay?.nodes ?? []).filter((r) => r.id === id);
  if (!rows.length) return;
  const sec = el("div", { class: "wf-runinfo" }, el("h4", {}, `this step in run ${overlay!.id.replace(/^run-/, "")}`));
  for (const r of rows) {
    const line = el("div", { class: `wf-runline ${r.state}` });
    line.append(`${STATE_GLYPH[r.state]} ${r.state}${r.index !== undefined ? ` #${r.index + 1}` : ""}${r.costUsd !== undefined ? ` · ${money(r.costUsd)}` : ""}${r.startedAt && r.endedAt ? ` · ${span(r.endedAt - r.startedAt)}` : ""}`);
    if (r.detail) line.append(el("div", { class: "wf-runline-detail" }, r.detail));
    if (r.sessionId) {
      const sid = r.sessionId;
      const open = el("button", { class: "btn btn-quiet" }, "session on the board");
      open.addEventListener("click", () => {
        deps.setView("board");
        deps.openSession(sid);
      });
      line.append(" ", open);
    }
    if (r.output || r.hasOutput) {
      const show = el("button", { class: "btn btn-quiet" }, "output");
      show.addEventListener("click", async () => {
        const text_ = r.output ?? (await fetchOutput(overlay!.id, r.id, r.index));
        show.replaceWith(el("pre", { class: "prompt" }, text_ ?? "(no output recorded)"));
      });
      line.append(" ", show);
    }
    sec.append(line);
  }
  host.append(sec);
}

async function fetchOutput(runId: string, node: string, index: number | undefined): Promise<string | null> {
  try {
    const r = await fetch(`/api/workflows/runs/${encodeURIComponent(runId)}`);
    if (!r.ok) return null;
    const { run } = (await r.json()) as { run: RunState };
    return run.nodes.find((n) => n.id === node && (n.index ?? -1) === (index ?? -1))?.output ?? null;
  } catch {
    return null;
  }
}

/* ---- the runs strip ------------------------------------------------------- */

function renderRunsStrip(): void {
  const host = $("#wf-runs");
  if (!host) return;
  host.textContent = "";
  if (!spec) return;
  const mine = runs.filter((r) => r.workflow === (savedName ?? spec!.name));
  if (!mine.length) {
    host.append(el("span", { class: "blurb" }, "No runs yet. Save, then run — every run lands on the board as one card with the whole chain in it."));
    return;
  }
  host.append(el("span", { class: "wf-runs-label" }, "runs"));
  for (const r of mine.slice(0, 8)) {
    const done = r.nodes.filter((n) => n.state === "done").length;
    const total = r.plan?.nodes.reduce((a, n) => a + n.width, 0) ?? r.nodes.length;
    const b = el("button", { class: `wf-runchip ${r.state}${overlay?.id === r.id ? " on" : ""}`, title: r.detail || r.state });
    b.append(el("i"), `${age(r.startedAt)} ago · ${r.state} · ${done}/${total}${r.costUsd !== null ? ` · ${money(r.costUsd)}` : ""}`);
    b.addEventListener("click", () => {
      overlay = overlay?.id === r.id ? null : r;
      renderStatus();
      renderBody();
      renderRunsStrip();
    });
    host.append(b);
  }
  const board = el("button", { class: "btn btn-quiet" }, "see them on the board");
  board.addEventListener("click", () => deps.setView("board"));
  host.append(board);
}

/* ---------------------------------------------------------------------------
 * server
 * ------------------------------------------------------------------------- */

async function refreshList(): Promise<void> {
  try {
    const data = (await (await fetch("/api/workflows")).json()) as { workflows: typeof list; dir: string };
    list = data.workflows;
    listDir = data.dir;
  } catch (e) {
    toast(`could not read workflows: ${String(e)}`, "err");
  }
  renderList();
}

async function refreshRuns(): Promise<void> {
  try {
    const data = (await (await fetch("/api/workflows/runs")).json()) as { runs: RunState[] };
    runs = data.runs;
    if (overlay) overlay = runs.find((r) => r.id === overlay!.id) ?? overlay;
  } catch {
    /* the stream will fill it in */
  }
}

async function openWorkflow(name: string): Promise<void> {
  if (dirty && spec && !confirm(`Discard unsaved changes to ${spec.name}?`)) return;
  try {
    const r = await fetch(`/api/workflows/${encodeURIComponent(name)}`);
    if (!r.ok) return toast("that workflow could not be read", "err");
    const body = (await r.json()) as { spec: WfSpec; problems: { where?: string; message: string }[] };
    spec = body.spec;
    spec.nodes ??= [];
    spec.edges ??= [];
    savedName = spec.name;
    selected = spec.nodes[0]?.id ?? null;
    selectedEdge = null;
    dirty = false;
    setProblems(body.problems);
    overlay = runs.find((x) => x.workflow === name) ?? null;
    renderAll();
  } catch (e) {
    toast(String(e), "err");
  }
}

function setProblems(rows: { where?: string; message: string }[]): void {
  problems = new Map();
  for (const p of rows) {
    const key = p.where && spec?.nodes.some((n) => n.id === p.where) ? p.where : "";
    problems.set(key, [...(problems.get(key) ?? []), p.where && key === "" ? `${p.where}: ${p.message}` : p.message]);
  }
}

async function save(): Promise<boolean> {
  if (!spec) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(spec.name)) {
    toast("the name must be letters, digits, dot, dash or underscore", "err");
    return false;
  }
  const r = await fetch(`/api/workflows/${encodeURIComponent(spec.name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
  const body = (await r.json()) as { ok?: boolean; detail?: string; error?: string; problems?: { where?: string; message: string }[] };
  if (!r.ok) {
    toast(body.error ?? body.detail ?? "not saved", "err");
    return false;
  }
  if (savedName && savedName !== spec.name) {
    // A rename: the old file would otherwise linger as a stale twin.
    await fetch(`/api/workflows/${encodeURIComponent(savedName)}`, { method: "DELETE" });
  }
  savedName = spec.name;
  dirty = false;
  setProblems(body.problems ?? []);
  report([
    { level: "ok", text: body.detail ?? "saved" },
    ...(body.problems ?? []).map((p) => ({ level: "warn" as const, text: p.where ? `${p.where}: ${p.message}` : p.message })),
  ]);
  await refreshList();
  renderBar();
  renderBody();
  return true;
}

async function check(): Promise<void> {
  if (!spec) return;
  if (dirty && !(await save())) return;
  report([{ level: "ok", text: "asking graphlint and preflight…" }]);
  const r = await fetch(`/api/workflows/${encodeURIComponent(spec.name)}/check`, { method: "POST" });
  if (!r.ok) return report([{ level: "bad", text: "check reads the file on disk and could not find it — save first" }]);
  const body = (await r.json()) as {
    problems: { where?: string; message: string }[];
    lint: { ok: boolean; skipped: boolean; detail: string };
    budget: { ok: boolean; skipped: boolean; detail: string };
  };
  setProblems(body.problems);
  renderBody();
  report([
    ...body.problems.map((p) => ({ level: "bad" as const, text: p.where ? `${p.where}: ${p.message}` : p.message })),
    { level: body.lint.ok ? (body.lint.skipped ? "warn" : "ok") : "bad", text: body.lint.detail },
    { level: body.budget.ok ? (body.budget.skipped ? "warn" : "ok") : "bad", text: body.budget.detail },
  ]);
}

async function run(force = false): Promise<void> {
  if (!spec) return;
  if (!deps.actionsEnabled()) {
    return report([{ level: "bad", text: "running starts Claude Code sessions, and actions are off. Restart localflow with --allow-actions." }]);
  }
  if (dirty && !(await save())) return;
  watchRuns();
  const r = await fetch(`/api/workflows/${encodeURIComponent(spec.name)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force }),
  });
  const body = (await r.json()) as { error?: string; detail?: string; runId?: string };
  if (!r.ok) return report([{ level: "bad", text: body.error ?? body.detail ?? "not started" }]);
  toast("started — it is on the board as one card, and lights up here as it goes", "ok");
  report([{ level: "ok", text: body.detail ?? "started" }]);
}

async function remove(): Promise<void> {
  if (!spec) return;
  const name = savedName ?? spec.name;
  if (!confirm(`Delete the workflow "${name}"? Runs already made keep their own copy of the chain.`)) return;
  if (savedName) {
    const r = await fetch(`/api/workflows/${encodeURIComponent(savedName)}`, { method: "DELETE" });
    const body = (await r.json()) as { detail?: string };
    toast(body.detail ?? "deleted", r.ok ? "ok" : "err");
  }
  spec = null;
  savedName = null;
  selected = null;
  overlay = null;
  dirty = false;
  await refreshList();
  renderAll();
}

function duplicate(): void {
  if (!spec) return;
  spec = JSON.parse(JSON.stringify(spec)) as WfSpec;
  spec.name = `${spec.name}-copy`;
  savedName = null;
  dirty = true;
  overlay = null;
  renderAll();
}

function exportJson(): void {
  if (!spec) return;
  const blob = new Blob([`${JSON.stringify(spec, null, 2)}\n`], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${spec.name}.graph.json` });
  a.click();
  URL.revokeObjectURL(a.href);
}

function report(lines: { level: "ok" | "warn" | "bad"; text: string }[]): void {
  const host = $("#wf-report");
  host.textContent = "";
  host.hidden = !lines.length;
  for (const l of lines) host.append(el("div", { class: `wf-line ${l.level}` }, l.text));
}

/**
 * Run progress, live.
 *
 * One stream for the whole tab rather than one per run: a run is minutes long
 * and a canvas left open should pick up whatever is happening without being
 * told to look.
 */
function watchRuns(): void {
  if (stream) return;
  stream = new EventSource("/api/workflows/runs/events");
  stream.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as { type: "run"; run: RunState } | { type: "node"; run: string; node: NodeRun };
      if (e.type === "run") {
        const at = runs.findIndex((r) => r.id === e.run.id);
        if (at >= 0) runs[at] = e.run;
        else runs.unshift(e.run);
        // A run just started for the open workflow is the one you want to watch.
        if (spec && e.run.workflow === (savedName ?? spec.name) && (!overlay || overlay.id === e.run.id || e.run.state === "running")) overlay = e.run;
      } else {
        const r = runs.find((x) => x.id === e.run);
        if (!r) return;
        // The runner emits a row per child, and a "running" row before them.
        // Replace the placeholder rather than stacking it up.
        const at = r.nodes.findIndex((n) => n.id === e.node.id && (n.index ?? -1) === (e.node.index ?? -1) && n.state === "running");
        if (at >= 0) r.nodes[at] = e.node;
        else r.nodes.push(e.node);
        if (typeof e.node.costUsd === "number" && e.node.state !== "running") r.costUsd = (r.costUsd ?? 0) + e.node.costUsd;
        if (overlay?.id === r.id) overlay = r;
      }
      if (inWorkflows()) {
        renderStatus();
        renderBody();
        renderRunsStrip();
        renderList();
      }
    } catch {
      /* a malformed frame is not worth tearing the tab down over */
    }
  };
  stream.onerror = () => {
    const s = $("#wf-status");
    if (s) s.textContent = "run stream disconnected";
  };
}

/* ---------------------------------------------------------------------------
 * the tab
 * ------------------------------------------------------------------------- */

export async function renderWorkflows(): Promise<void> {
  await Promise.all([refreshList(), refreshRuns()]);
  if (!spec && list[0]?.spec) await openWorkflow(list[0].name);
  else renderAll();
  watchRuns();
}

export function wireWorkflows(d: Deps): void {
  deps = d;
  $("#wf-new").addEventListener("click", () => {
    if (dirty && spec && !confirm(`Discard unsaved changes to ${spec.name}?`)) return;
    startNew("blank");
  });
  ($("#wf-name") as HTMLInputElement).addEventListener("input", (ev) => {
    if (!spec) return;
    spec.name = (ev.target as HTMLInputElement).value.trim();
    dirty = true;
    $("#wf-dirty").hidden = false;
  });
  $("#wf-save").addEventListener("click", () => void save());
  $("#wf-check").addEventListener("click", () => void check());
  $("#wf-run").addEventListener("click", () => void run());
  const more = $("#wf-more");
  const menu = $("#wf-menu");
  more.addEventListener("click", (ev) => {
    ev.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", () => (menu.hidden = true));
  $("#wf-force").addEventListener("click", () => void run(true));
  $("#wf-dup").addEventListener("click", duplicate);
  $("#wf-export").addEventListener("click", exportJson);
  $("#wf-delete").addEventListener("click", () => void remove());
  ($("#wf-q") as HTMLInputElement).addEventListener("input", (ev) => {
    paletteQuery = (ev.target as HTMLInputElement).value;
    renderPalette();
  });

  document.addEventListener("keydown", (e) => {
    if (!inWorkflows() || !spec) return;
    const tag = (document.activeElement?.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void save();
      }
      return;
    }
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedEdge) disconnect(selectedEdge.from, selectedEdge.to);
      else if (selected) removeNode(selected);
    } else if (e.key === "Escape") {
      selected = null;
      selectedEdge = null;
      renderBody();
    }
  });

  addEventListener("resize", () => {
    if (inWorkflows() && spec) renderCanvas();
  });
  // Runs come in on the board frame too, so a card can be drawn before the
  // tab has ever been opened. Seed from there when the tab is not the source.
  addEventListener("localflow:board", () => {
    const fromBoard = deps.board()?.runs;
    if (!fromBoard || stream) return;
    runs = fromBoard;
  });
}

/* ---------------------------------------------------------------------------
 * the board: a run as one card, and the drawer behind it
 * ------------------------------------------------------------------------- */

const RUN_LABEL: Record<RunState["state"], string> = { running: "running", done: "finished", failed: "failed", refused: "refused" };

/** The chain, as chips in columns — enough of the picture to read from a lane. */
export function chainStrip(r: RunState, max = 4): HTMLElement {
  const strip = el("div", { class: "chain" });
  const plan = r.plan;
  const cols = plan ? layers(plan) : [[...new Set(r.nodes.map((n) => n.id))]];
  const titles = new Map(plan?.nodes.map((n) => [n.id, n]) ?? []);
  cols.forEach((col, i) => {
    if (i) strip.append(el("span", { class: "chain-arrow" }, "›"));
    const column = el("div", { class: "chain-col" });
    const shown = col.length > max ? col.slice(0, max - 1) : col;
    for (const id of shown) {
      const p = titles.get(id);
      const state = stateOf(r, id) ?? "pending";
      const c = el("span", { class: `chain-step ${state}`, title: `${p?.label ?? id} — ${state}` });
      c.append(el("i", { class: "glyph" }, p ? KIND_GLYPH[p.kind] : "¶"), (p?.label ?? id).slice(0, 18));
      if (p && p.width > 1) c.append(el("b", {}, `×${p.width}`));
      column.append(c);
    }
    if (col.length > shown.length) column.append(el("span", { class: "chain-step more" }, `+${col.length - shown.length}`));
    strip.append(column);
  });
  return strip;
}

export function runCard(r: RunState): HTMLElement {
  const c = el("article", { class: `card run ${r.state}`, tabIndex: 0 });
  c.dataset.id = `run:${r.id}`;
  c.dataset.run = r.id;
  c.draggable = false;

  const h = el("h3");
  h.append(el("span", { class: "src", title: "a workflow run" }, "wf"), r.workflow);
  c.append(h);

  const meta = el("div", { class: "meta" });
  meta.append(el("span", { class: `run-state ${r.state}` }, RUN_LABEL[r.state]));
  const done = r.nodes.filter((n) => n.state === "done").length;
  const total = r.plan?.nodes.reduce((a, n) => a + n.width, 0) ?? r.nodes.length;
  meta.append(el("span", {}, `${done}/${total} steps`));
  meta.append(r.costUsd === null ? el("span", { class: "unknown" }, "nothing priced yet") : el("span", { class: "cost" }, money(r.costUsd)));
  meta.append(el("span", {}, r.endedAt ? `took ${span(r.endedAt - r.startedAt)}` : `started ${age(r.startedAt)} ago`));
  if (r.restored) meta.append(el("span", { class: "warn", title: "read back from the archive after a restart — outputs were not kept" }, "from the archive"));
  c.append(meta);

  c.append(chainStrip(r));
  if (r.state === "refused" || r.state === "failed") c.append(el("div", { class: "sub" }, el("span", { class: "err" }, r.detail)));
  else if (r.plan?.cwd) c.append(el("div", { class: "sub" }, tilde(r.plan.cwd)));
  return c;
}

export async function openRunDrawer(id: string): Promise<void> {
  let r = runs.find((x) => x.id === id) ?? deps.board()?.runs?.find((x) => x.id === id) ?? null;
  // The board's copy has no output; the run endpoint has everything.
  try {
    const res = await fetch(`/api/workflows/runs/${encodeURIComponent(id)}`);
    if (res.ok) r = ((await res.json()) as { run: RunState }).run;
  } catch {
    /* the board's copy is enough to draw the chain */
  }
  if (!r) return;
  const run_ = r;
  $("#d-title").textContent = `${run_.workflow} · ${RUN_LABEL[run_.state]}`;
  const body = $("#d-body");
  body.replaceChildren();

  const kv = el("dl", { class: "kv" });
  const add = (k: string, v: string) => kv.append(el("dt", {}, k), el("dd", {}, v));
  add("run", run_.id);
  add("state", run_.state);
  add("started", new Date(run_.startedAt).toLocaleString());
  if (run_.endedAt) add("took", span(run_.endedAt - run_.startedAt));
  add("cost", run_.costUsd === null ? "nothing priced yet" : `${money(run_.costUsd)} — what the CLI reported, summed`);
  if (run_.plan?.cwd) add("cwd", run_.plan.cwd);
  if (run_.detail) add(run_.state === "refused" ? "refused because" : "gates", run_.detail);
  if (run_.restored) add("note", "restored from the archive after a restart — outputs and timings were not kept");
  body.append(el("section", { class: "sec" }, el("h4", {}, "workflow run"), kv));

  if (run_.plan) {
    const stage = renderStage(planNodes(run_.plan), run_.plan.edges, { geo: COMPACT, run: run_, editable: false });
    body.append(el("section", { class: "sec" }, el("h4", {}, "the chain"), el("div", { class: "dag wf-dag" }, stage)));
  }

  const steps = el("div", { class: "wf-steps" });
  const order = run_.plan ? layers(run_.plan).flat() : [...new Set(run_.nodes.map((n) => n.id))];
  const tasks = deps.board()?.tasks ?? [];
  for (const nid of order) {
    const p = run_.plan?.nodes.find((n) => n.id === nid);
    const rows = run_.nodes.filter((n) => n.id === nid);
    const state = stateOf(run_, nid) ?? "pending";
    const step = el("div", { class: `wf-step ${state}` });
    const head = el("div", { class: "wf-step-head" });
    head.append(el("span", { class: `glyph` }, p ? KIND_GLYPH[p.kind] : "¶"), el("b", {}, p?.label ?? nid), el("span", { class: `state ${state}` }, `${STATE_GLYPH[state]} ${state}`));
    const cost = costOf(run_, nid);
    if (cost !== null) head.append(el("span", { class: "cost" }, money(cost)));
    step.append(head);
    const meta = p ? [p.model ? shortModel(p.model) : null, p.agent ? `@${p.agent}` : null, p.command].filter(Boolean).join(" · ") : "";
    if (meta) step.append(el("div", { class: "hint" }, meta));
    for (const row of rows) {
      const line = el("div", { class: "wf-step-row" });
      if (row.index !== undefined) line.append(el("span", { class: "hint" }, `copy ${row.index + 1}`));
      if (row.detail) line.append(el("span", { class: "hint" }, row.detail));
      if (row.sessionId) {
        const sid = row.sessionId;
        const onBoard = tasks.some((t) => t.id === sid);
        const b = el("button", { class: "btn btn-quiet", title: sid }, onBoard ? "session" : "session (not on the board now)");
        b.disabled = !onBoard;
        b.addEventListener("click", () => deps.openSession(sid));
        line.append(b);
      }
      if (row.output) {
        const b = el("button", { class: "btn btn-quiet" }, "output");
        b.addEventListener("click", () => b.replaceWith(el("pre", { class: "prompt" }, row.output ?? "")));
        line.append(b);
      }
      if (line.childElementCount) step.append(line);
    }
    steps.append(step);
  }
  body.append(el("section", { class: "sec" }, el("h4", {}, "steps"), steps));

  const actions = el("div", { class: "actions" });
  const edit = el("button", { class: "btn" }, "open in the editor");
  edit.addEventListener("click", () => {
    deps.closeDrawer();
    deps.setView("workflows");
    void (async () => {
      await refreshList();
      if (list.some((w) => w.name === run_.workflow)) {
        await openWorkflow(run_.workflow);
        overlay = run_;
        renderStatus();
        renderBody();
        renderRunsStrip();
      } else toast(`the workflow file "${run_.workflow}" is no longer on disk — the chain above is the run's own copy`, "info");
    })();
  });
  actions.append(edit);
  if (deps.actionsEnabled() && run_.state !== "running") {
    const again = el("button", { class: "btn primary" }, "run again");
    again.addEventListener("click", async () => {
      const res = await fetch(`/api/workflows/${encodeURIComponent(run_.workflow)}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const b = (await res.json()) as { error?: string; detail?: string };
      toast(b.error ?? b.detail ?? "started", res.ok ? "ok" : "err");
      if (res.ok) deps.closeDrawer();
    });
    actions.append(again);
  }
  body.append(el("section", { class: "sec" }, el("h4", {}, "actions"), actions));

  $("#drawer").hidden = false;
  $("#scrim").hidden = false;
}
