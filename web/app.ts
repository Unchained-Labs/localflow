/**
 * The board, client side.
 *
 * No framework. The whole app is a list of cards keyed by session id that is
 * re-rendered whenever the server pushes a new snapshot, and at four columns of
 * a dozen cards that is far below the point where a diffing library earns its
 * download. Cards are reused by key rather than rebuilt, so a card you are
 * hovering does not flicker every two seconds.
 */

type Lane = "queued" | "running" | "waiting" | "ended";

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  thinking: number;
}

interface Fanout {
  messageId: string;
  at: number;
  width: number;
  children: { description: string; prompt: string; agentType?: string }[];
  failed: number;
}

interface Task {
  id: string;
  source: "claude" | "otter";
  lane: Lane;
  outcome: "unknown" | "errors-seen";
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
  costUsd: number | null;
  cacheHitRate: number | null;
  tools: Record<string, number>;
  toolErrors: number;
  fanouts: Fanout[];
  transcriptPath?: string;
  /** The declared device this ran on. Absent means this machine. */
  device?: string;
  remoteId?: string;
  /** Only the tail of the transcript was mirrored: tokens and cost are floors. */
  partial?: boolean;
  /** Last known state of a device that is not answering right now. */
  staleSince?: number;
}

/**
 * The observed graph, exactly as `/api/task/<id>/graph` serves it.
 *
 * Mirrors ObservedSpec in src/graph.ts. The drawer reads it rather than
 * re-deriving anything from the fan-outs: which groups are verifier panels and
 * why a barrier is a barrier are rules, the server owns them, and a second
 * implementation here would eventually disagree with the first.
 */
interface SpecNode {
  id: string;
  tier?: string;
  phase?: string;
  model?: string;
  fanout?: { over: string; width: number; maxConcurrent?: number };
  harness?: { kind: string; lenses?: string[]; passIf?: string };
}

interface SpecEdge {
  from: string;
  to: string;
  channel?: string;
  barrier?: boolean;
  barrierReason?: string;
}

interface ObservedSpec {
  name: string;
  description: string;
  nodes: SpecNode[];
  edges: SpecEdge[];
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

/** What `/api/task/<id>/review` returns: the family's opinion of this graph. */
interface LintFinding {
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  aboutTheInput?: string;
}

interface ReviewDetail {
  lint: {
    ok: boolean;
    detail: string;
    version?: string;
    findings: LintFinding[];
    summary: { errors: number; warnings: number; infos: number };
  };
  estimate: {
    ok: boolean;
    detail: string;
    version?: string;
    agents?: { low: number; expected: number; high: number };
    usd?: { low: number; expected: number; high: number };
    assumedWidths: string[];
  };
  gap: { ratio: number; note: string } | null;
  lenses: {
    ok: boolean;
    detail: string;
    version?: string;
    domain: string;
    lenses: { key: string; question: string; catches: string; model?: string; oracleHint?: string }[];
  } | null;
  noVerdicts: string | null;
}

interface GraphNote {
  level: "info" | "warn";
  rule: string;
  message: string;
}

/** What the graph endpoint returns in one response. */
interface GraphDetail {
  spec: ObservedSpec;
  notes: GraphNote[];
}

interface Board {
  tasks: Task[];
  lanes: Record<Lane, number>;
  totals: { usage: Usage; costUsd: number | null; sessions: number; cacheHitRate: number | null };
  degraded: { id: string; reason: string }[];
  generatedAt: number;
  pricingVerified?: string;
  error?: string;
}

const LANES: { lane: Lane; label: string; blurb: string }[] = [
  { lane: "running", label: "running", blurb: "The model is working right now." },
  { lane: "queued", label: "queued", blurb: "Prompts accepted and not started." },
  { lane: "waiting", label: "waiting on you", blurb: "Idle with an empty queue — it wants an answer." },
  { lane: "ended", label: "ended", blurb: "No longer in the registry. Whether it succeeded is not recorded." },
];

import { OTHER, breakdown, histogram, seriesColor, statTile, timeBars } from "./charts.js";

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let board: Board | null = null;
let selected: string | null = null;
let actionsEnabled = false;

// ---- formatting -------------------------------------------------------------

function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/**
 * True when a session yielded nothing worth a card.
 *
 * Some transcripts are empty, or hold only metadata: no model, no tokens, no
 * working directory, and so no price. The session is real, so it is still
 * counted, but it has nothing to say.
 */
function isBare(t: Task): boolean {
  return !t.model && t.costUsd === null && !t.cwd && !t.usage.output;
}

function money(usd: number | null): string {
  if (usd === null) return "—";
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

function age(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const shortModel = (m?: string) => (m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "");
const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...kids: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = String(v);
    else if (v !== undefined && v !== null) (n as Record<string, unknown>)[k] = v;
  }
  for (const kid of kids) if (kid != null) n.append(kid as Node | string);
  return n;
}

// ---- toasts -----------------------------------------------------------------

/** An element's usable width: what is inside its own padding. */
function innerWidthOf(node: HTMLElement, fallback = 520): number {
  const w = node.clientWidth;
  if (!w) return fallback;
  const cs = getComputedStyle(node);
  const inner = w - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
  return inner > 80 ? inner : fallback;
}

function toast(msg: string, kind: "ok" | "err" | "info" = "info", ms = 6000): void {
  const t = el("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

// ---- rendering --------------------------------------------------------------

/**
 * The header numbers.
 *
 * Recomputed from the visible cards when a machine filter is on, rather than
 * showing the server's fleet-wide totals. A header reading $104 above a lane
 * filtered to one laptop is not a rounding problem, it is the wrong number:
 * whatever the board is showing, the totals are the totals *of that*.
 */
function renderTotals(b: Board): void {
  const rows = fleetFilter === null ? null : b.tasks.filter((t) => (t.device ?? "") === fleetFilter);

  let sessions = b.totals.sessions;
  let out = b.totals.usage.output;
  let cost = b.totals.costUsd;
  let hit = b.totals.cacheHitRate;

  if (rows) {
    sessions = rows.length;
    out = rows.reduce((a, t) => a + t.usage.output, 0);
    // Null, not zero, when nothing in view has a price — the same rule the
    // server follows, for the same reason.
    const priced = rows.filter((t) => t.costUsd !== null);
    cost = priced.length ? priced.reduce((a, t) => a + (t.costUsd ?? 0), 0) : null;
    const read = rows.reduce((a, t) => a + t.usage.cacheRead, 0);
    const fresh = rows.reduce((a, t) => a + t.usage.input, 0);
    hit = read + fresh > 0 ? read / (read + fresh) : null;
  }

  // A total with no period is a number nobody can check. These cover exactly
  // the sessions on the board, so the label says so and the tooltip gives the
  // window they span.
  const stamps = (rows ?? b.tasks).map((t) => t.updatedAt).filter(Boolean);
  const span =
    stamps.length > 0
      ? `${new Date(Math.min(...stamps)).toLocaleDateString()} – ${new Date(
          Math.max(...stamps),
        ).toLocaleDateString()}`
      : "no sessions";

  const cells: [string, string, string][] = [
    [
      String(sessions),
      rows ? `sessions on ${fleetFilter || "this machine"}` : "sessions",
      `Every session localflow could find${rows ? ` on ${fleetFilter || "this machine"}` : ""}.`,
    ],
    [tokens(out), "output tokens", "Output tokens across the sessions listed."],
    [
      money(cost),
      "spent · these sessions",
      `Derived from measured tokens at built-in prices` +
        (b.pricingVerified ? ` verified ${b.pricingVerified},` : ",") +
        ` ` +
        `not reported by the provider. Sessions with no known price are excluded. Spans ${span}.`,
    ],
    [
      hit === null ? "—" : `${Math.round(hit * 100)}%`,
      "from cache",
      "Share of input tokens served from the prompt cache.",
    ],
  ];
  const host = $("#totals");
  host.replaceChildren(
    ...cells.map(([v, k, tip]) =>
      el("div", { class: "t", title: tip }, el("b", {}, v), el("span", {}, k)),
    ),
  );
}

function card(t: Task): HTMLElement {
  const cls = ["card"];
  if (t.source === "otter") cls.push("otter");
  if (t.device) cls.push("remote");
  if (t.staleSince) cls.push("stale");
  const c = el("article", { class: cls.join(" "), tabIndex: 0 });
  c.dataset.id = t.id;
  if (t.device) c.dataset.device = t.device;
  c.draggable = true;

  // The machine leads the title. On a fleet board it is the fact that makes
  // every other fact on the card mean something, and a local session stays
  // unlabelled so that a label keeps being worth reading.
  const h = el("h3");
  if (t.device) h.append(el("span", { class: "on" }, t.device));
  h.append(t.title);
  c.append(h);

  const meta = el("div", { class: "meta" });
  meta.append(el("span", {}, t.name));
  if (t.model) meta.append(el("span", {}, shortModel(t.model)));
  if (t.usage.output) meta.append(el("span", {}, `${tokens(t.usage.output)} out`));
  meta.append(
    t.costUsd === null
      ? el("span", { class: "unknown" }, "cost unknown")
      : el("span", { class: "cost" }, money(t.costUsd)),
  );
  if (t.cacheHitRate !== null) meta.append(el("span", {}, `${Math.round(t.cacheHitRate * 100)}% cached`));
  meta.append(el("span", {}, age(t.updatedAt)));
  // Two ways a remote card can be less than it looks, both stated on the card
  // rather than only in the degraded strip, because the number they qualify is
  // right here next to them.
  if (t.partial) meta.append(el("span", { class: "warn", title: "only the tail of this transcript was mirrored" }, "cost is a floor"));
  if (t.staleSince) meta.append(el("span", { class: "warn" }, `unreachable · last seen ${age(t.staleSince)} ago`));
  c.append(meta);

  const sub = el("div", { class: "sub" });
  const bits: (string | Node)[] = [];
  if (t.cwd) bits.push(tilde(t.cwd));
  if (t.branch) bits.push(t.branch);
  if (t.lastToolName) bits.push(`last: ${t.lastToolName}`);
  const children = t.fanouts.reduce((a, f) => a + f.width, 0);
  if (children) {
    const widest = t.fanouts.reduce((a, f) => Math.max(a, f.width), 0);
    bits.push(widest > 1 ? `${children} agents, widest ${widest}` : `${children} agent calls`);
  }
  if (t.queue.length) bits.push(el("span", { class: "queued" }, `${t.queue.length} queued`));
  if (t.toolErrors)
    bits.push(
      el(
        "span",
        {
          class: "err",
          title:
            "Tool calls that returned an error to the model. Agents retry, so a " +
            "count above zero is normal; a count that dwarfs the session's tool " +
            "calls is the signal worth chasing.",
        },
        `${t.toolErrors} tool errors`,
      ),
    );
  bits.forEach((b, i) => {
    if (i) sub.append(" · ");
    sub.append(b as Node | string);
  });
  if (bits.length) c.append(sub);

  // Cache share, as a bar. It is the single biggest lever on what a session
  // costs, so it gets a graphic rather than only a number.
  if (t.cacheHitRate !== null) {
    c.append(el("div", { class: "bar" }, el("i", { style: `width:${Math.round(t.cacheHitRate * 100)}%` } as never)));
  }
  return c;
}

/**
 * Which machine's cards to show. Null is "all of them".
 *
 * Held here rather than in the URL on purpose: it is a way of looking at a live
 * board, not a place you would send someone.
 */
let fleetFilter: string | null = null;

/** Every machine with a card on the current board, this one first. */
function machines(b: Board): string[] {
  const seen = new Set<string>();
  for (const t of b.tasks) seen.add(t.device ?? "");
  return [...seen].sort((a, x) => (a === "" ? -1 : x === "" ? 1 : a.localeCompare(x)));
}

/**
 * The fleet bar.
 *
 * Counts sit on the chips because the question a fleet view answers is "where
 * is the work", and a row of names without numbers makes you click each one to
 * find out. A machine whose cards are all stale says so on its chip, so you can
 * see that a machine has gone quiet without first filtering to it.
 */
function renderFleet(b: Board): void {
  const bar = $("#fleet");
  const names = machines(b);
  if (names.length < 2) {
    // One machine is not a fleet. Keep the filter off rather than showing a
    // control whose only setting is the one you are already looking at.
    bar.hidden = true;
    if (fleetFilter !== null) fleetFilter = null;
    return;
  }
  bar.hidden = false;
  bar.textContent = "";

  const chip = (key: string | null, label: string, n: number, stale: boolean) => {
    const b2 = el("button", {
      class: `fchip${fleetFilter === key ? " on" : ""}${stale ? " stale" : ""}`,
      type: "button",
    });
    b2.append(label, el("span", { class: "n" }, String(n)));
    b2.addEventListener("click", () => {
      fleetFilter = fleetFilter === key ? null : key;
      if (board) {
        renderTotals(board);
        renderBoard(board);
      }
    });
    bar.append(b2);
  };

  chip(null, "all", b.tasks.length, false);
  for (const name of names) {
    const rows = b.tasks.filter((t) => (t.device ?? "") === name);
    chip(
      name || "",
      name || "this machine",
      rows.length,
      rows.length > 0 && rows.every((t) => t.staleSince),
    );
  }
}

function renderBoard(b: Board): void {
  const host = $("#board");
  const existing = new Map<string, HTMLElement>();
  host.querySelectorAll<HTMLElement>(".card").forEach((c) => existing.set(c.dataset.id!, c));

  renderFleet(b);
  const shown = fleetFilter === null ? b.tasks : b.tasks.filter((t) => (t.device ?? "") === fleetFilter);

  host.replaceChildren(
    ...LANES.map(({ lane, label, blurb }) => {
      const all = shown.filter((t) => t.lane === lane);
      // A transcript we could read nothing out of still produced a task, and a
      // full card for it sat next to a four-figure session claiming the same
      // amount of attention. They collapse to one line instead.
      const inLane = all.filter((t) => !isBare(t));
      const bare = all.filter(isBare);
      const body = el("div", { class: "lane-body" });
      if (!all.length) body.append(el("p", { class: "empty" }, blurb));
      for (const t of inLane) {
        // Reuse the node when nothing on the card changed, so hover and focus
        // survive a poll.
        const prev = existing.get(t.id);
        const fresh = card(t);
        if (prev && prev.innerHTML === fresh.innerHTML) body.append(prev);
        else body.append(fresh);
      }
      if (bare.length) {
        body.append(
          el(
            "p",
            {
              class: "bare",
              title: bare.map((t) => t.name).join(", "),
            },
            `${bare.length} session${bare.length === 1 ? "" : "s"} with nothing readable in the transcript`,
          ),
        );
      }
      return el(
        "section",
        { class: `lane lane-${lane}` },
        el(
          "div",
          { class: "lane-head" },
          el("i", { class: "dot" } as never),
          label,
          el("span", { class: "n" }, String(all.length)),
        ),
        body,
      );
    }),
  );

  const deg = $("#degraded");
  if (b.degraded.length) {
    deg.textContent = `${b.degraded.length} note(s) — ${b.degraded
      .map((d) => `${d.id.startsWith("device:") ? `@${d.id.slice("device:".length)}` : d.id.slice(0, 8)}: ${d.reason}`)
      .join("; ")}`;
    deg.hidden = false;
  } else {
    deg.hidden = true;
  }
}

// ---- the graph that ran -----------------------------------------------------
//
// A real DAG, drawn as one: a root, a layer per group, edges that split into
// the agents issued together and converge again at the barrier that followed.
//
// Two earlier versions were wrong in opposite directions. The first was an SVG
// of dots on a spine drawn in viewBox units and scaled to whatever width the
// drawer happened to be, so every font size was a function of container width —
// which is why "session" arrived three times the size of the labels under it.
// The second fixed the type by giving up on drawing: a stack of DOM rows, which
// reads well and is not a graph. Nothing branched, nothing converged, and a
// five-wide fan-out did not visibly fan out.
//
// The mistake was blaming SVG for what viewBox scaling did. Drawn at 1:1 pixel
// units there is no scaling to go wrong, so this is a diagram with predictable
// type: the nodes are boxes with the child's own description in them, the edges
// are the real edges, and when the widest layer does not fit the panel scrolls
// sideways rather than shrinking the text until it stops being text.

const NS = "http://www.w3.org/2000/svg";

/** Geometry. Pixels, all of them, because the drawing is never rescaled. */
const NODE_W = 116;
const NODE_H = 46;
const GAP_X = 12;
const LAYER_GAP = 58;   // room between a layer and the next, where the barrier sits
const PAD = 14;
/** Every layer is captioned above itself, so the first one needs the room. */
const CAPTION_H = 16;
const ROOT_W = 168;
/** Below this the boxes stop holding a readable word, so the panel scrolls instead. */
const MIN_NODE_W = 84;

/** Attach a `<title>`, which is how an SVG node gets a tooltip. */
function titled<T extends SVGElement>(node: T, text: string): T {
  const t = document.createElementNS(NS, "title");
  t.textContent = text;
  node.append(t);
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * Fit a label into a box, in lines.
 *
 * SVG text has no `text-overflow`, so the wrapping is done here against the
 * monospace advance rather than guessed. Two lines, then an ellipsis — and the
 * full text is on the node's `<title>` either way, so truncation never loses
 * anything, it only defers it to the pointer.
 */
function fitLabel(text: string, width: number, lines = 2, charPx = 5.9): string[] {
  const perLine = Math.max(4, Math.floor((width - 12) / charPx));
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (trial.length <= perLine) {
      cur = trial;
      continue;
    }
    if (cur) out.push(cur);
    cur = w;
    if (out.length === lines) break;
  }
  if (cur && out.length < lines) out.push(cur);
  if (!out.length) return [text.slice(0, perLine)];
  // A word longer than the line, and the tail that did not fit, both end in "…".
  const consumed = out.join(" ").length;
  if (consumed < text.length) {
    const last = out[out.length - 1] ?? "";
    out[out.length - 1] = `${last.slice(0, Math.max(1, perLine - 1))}…`;
  }
  return out;
}

interface Layer {
  /** Empty for the root layer, which is one node with no fan-out. */
  children: { label: string; title: string; failed: boolean }[];
  phase: string;
  meta: string;
  /** The barrier that preceded this layer, if the spec recorded one. */
  barrier?: string;
  /** The server called this group a panel of verifiers. */
  panel?: string;
}

/** Turn the task and its spec into layers. All the reading happens here. */
function graphLayers(t: Task, spec: ObservedSpec | null): Layer[] {
  const tier = spec?.nodes.find((n) => n.id === "session")?.tier;
  const layers: Layer[] = [
    {
      children: [],
      phase: "session",
      meta: [shortModel(t.model), tier, t.effort && `${t.effort} effort`].filter(Boolean).join(" · "),
    },
  ];

  // nodes[0] is the session; nodes[i + 1] and edges[i] belong to fanouts[i].
  t.fanouts.forEach((f, i) => {
    const node = spec?.nodes[i + 1];
    const edge = spec?.edges[i];
    layers.push({
      phase: node?.phase ?? `Fan-out ${i + 1}`,
      meta: `${f.width === 1 ? "1 agent" : `${f.width} wide`}${f.failed ? ` · ${f.failed} failed` : ""}`,
      barrier: edge?.barrier ? (edge.barrierReason ?? "observed") : undefined,
      // Labelled by the server, not guessed here: `harness.kind` is set by
      // observedSpec when the group looked like a panel of verifiers.
      panel: node?.harness?.kind,
      children: f.children.map((c, k) => ({
        label: c.description || c.agentType || "agent",
        title: [c.agentType && `[${c.agentType}]`, c.description, c.prompt].filter(Boolean).join("\n\n"),
        failed: k < f.failed,
      })),
    });
  });
  return layers;
}

/**
 * The whole graph.
 *
 * Node width shrinks to fit the panel down to a floor, and past that the panel
 * scrolls. Shrinking without a floor is how the first version ended up with
 * text nobody could read, and hiding the overflow would be a diagram that lies
 * about how wide the fan-out got.
 */
function graphView(t: Task, spec: ObservedSpec | null, available: number): HTMLElement | null {
  if (!t.fanouts.length) return null;

  const layers = graphLayers(t, spec);
  const widest = Math.max(1, ...layers.map((l) => l.children.length));

  const usable = Math.max(240, available - PAD * 2);
  const nodeW = Math.max(MIN_NODE_W, Math.min(NODE_W, Math.floor((usable - GAP_X * (widest - 1)) / widest)));
  const rowW = Math.max(ROOT_W, widest * nodeW + (widest - 1) * GAP_X);
  const width = rowW + PAD * 2;
  const height = PAD * 2 + CAPTION_H + layers.length * NODE_H + (layers.length - 1) * LAYER_GAP;

  const agents = layers.slice(1).reduce((a, l) => a + l.children.length, 0);
  const root = titled(
    svg("svg", { width, height, class: "dag-svg", role: "img" }),
    `${t.fanouts.length} fan-out(s), ${agents} agent(s)`,
  );

  const centreX = PAD + rowW / 2;
  let y = PAD + CAPTION_H;

  /** Where the previous layer's edges leave from. */
  let hubY = 0;

  layers.forEach((layer, li) => {
    const isRoot = li === 0;
    const n = Math.max(1, layer.children.length);
    const w = isRoot ? ROOT_W : nodeW;
    const rowWidth = isRoot ? ROOT_W : n * nodeW + (n - 1) * GAP_X;
    const x0 = centreX - rowWidth / 2;

    // ---- the edges into this layer -----------------------------------------
    if (li > 0) {
      const midY = hubY + LAYER_GAP / 2;
      // Down from the previous layer's hub, across, then down into each node:
      // an orthogonal split, which is what makes a fan-out read as a fan-out.
      root.append(svg("path", { class: "dag-edge", d: `M ${centreX} ${hubY} V ${midY}` }));
      for (let k = 0; k < n; k++) {
        const cx = x0 + k * (w + GAP_X) + w / 2;
        root.append(
          svg("path", { class: "dag-edge", d: `M ${centreX} ${midY} H ${cx} V ${y}` }),
        );
      }
      if (layer.barrier) {
        root.append(
          titled(
            svg("line", {
              class: "dag-barrier-line",
              x1: centreX - Math.min(rowWidth, 120) / 2,
              x2: centreX + Math.min(rowWidth, 120) / 2,
              y1: midY,
              y2: midY,
            }),
            layer.barrier,
          ),
        );
      }
    }

    // ---- the layer's own label ---------------------------------------------
    //
    // Sat directly on the edges before, so the split lines ran through the
    // letters. Knocked out of the background instead: the caption is text over
    // a drawing, and text over a drawing needs the drawing to stop behind it.
    const head = `${layer.phase}${layer.meta ? `  ${layer.meta}` : ""}`;
    const headW = (head.length + (layer.panel ? layer.panel.length + 2 : 0)) * 5.9;
    root.append(
      svg("rect", {
        class: "dag-caption-bg",
        x: PAD - 4,
        y: y - 19,
        width: headW + 8,
        height: 15,
        rx: 3,
      }),
    );
    const caption = svg("text", { class: "dag-caption", x: PAD, y: y - 8 });
    caption.textContent = head;
    root.append(caption);
    if (layer.panel) {
      const tag = svg("text", { class: "dag-caption panel", x: PAD + (head.length + 2) * 5.9, y: y - 8 });
      tag.textContent = layer.panel;
      root.append(tag);
    }

    // ---- the nodes ----------------------------------------------------------
    if (isRoot) {
      const g = svg("g", { class: "dag-n root" });
      g.append(svg("rect", { x: x0, y, width: ROOT_W, height: NODE_H, rx: 7 }));
      const label = svg("text", { class: "dag-label", x: x0 + ROOT_W / 2, y: y + NODE_H / 2 + 4 });
      label.textContent = "session";
      g.append(label);
      root.append(g);
    } else {
      layer.children.forEach((c, k) => {
        const x = x0 + k * (nodeW + GAP_X);
        const g = svg("g", { class: `dag-n${c.failed ? " bad" : ""}` });
        g.append(svg("rect", { x, y, width: nodeW, height: NODE_H, rx: 6 }));
        const lines = fitLabel(c.label, nodeW);
        lines.forEach((line, i) => {
          const text = svg("text", {
            class: "dag-label",
            x: x + nodeW / 2,
            y: y + NODE_H / 2 + (lines.length === 1 ? 4 : i * 12 - 1),
          });
          text.textContent = line;
          g.append(text);
        });
        // The prompt is the evidence for everything the panel above claims —
        // correlated verifiers in particular are an assertion about these strings.
        titled(g, c.title);
        root.append(g);
      });
    }

    hubY = y + NODE_H;
    y += NODE_H + LAYER_GAP;
  });

  const wrap = el("div", { class: "dag" });
  wrap.append(root);
  return wrap;
}

/**
 * The same graph, given the window instead of the drawer.
 *
 * A `<dialog>` rather than a new pane: Escape and the backdrop already work,
 * and the graph is something you open, look at, and close rather than a place
 * you navigate to.
 */
function expandGraph(t: Task, spec: ObservedSpec | null): void {
  const dlg = document.createElement("dialog");
  dlg.className = "graph-modal";

  const head = el("div", { class: "graph-modal-head" });
  head.append(el("strong", {}, t.title));
  const close = el("button", { class: "icon" }, "✕");
  close.addEventListener("click", () => dlg.close());
  head.append(close);
  dlg.append(head);

  // Room for the drawing, less the dialog's own padding and a margin from the
  // window edge. The layout still scrolls past this; it just rarely has to.
  const wide = Math.min(window.innerWidth - 120, 1400);
  const g = graphView(t, spec, wide);
  if (g) dlg.append(g);

  dlg.addEventListener("close", () => dlg.remove());
  // Clicking the backdrop is a click on the dialog itself, outside its content.
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  document.body.append(dlg);
  dlg.showModal();
}

/**
 * What graphlint and preflight say about the graph that ran.
 *
 * Everything here is passed through from the tools themselves. Absence is
 * rendered as absence — "graphlint is not installed" is a different sentence
 * from "graphlint found nothing", and a panel that blurred the two would be the
 * false clean this family exists to argue against.
 */
async function appendReview(body: HTMLElement, t: Task): Promise<void> {
  let r: ReviewDetail;
  try {
    const res = await fetch(`/api/task/${encodeURIComponent(t.id)}/review`);
    if (!res.ok) return;
    r = (await res.json()) as ReviewDetail;
  } catch {
    return;
  }
  // The drawer may have moved on to another session while two subprocesses ran.
  if (selected !== t.id) return;

  const sec = el("section", { class: "sec" }, el("h4", {}, "what the rest of the family says"));

  if (!r.lint.ok) {
    sec.append(el("p", { class: "hint" }, r.lint.detail));
  } else {
    const { errors, warnings } = r.lint.summary;
    sec.append(
      el(
        "p",
        { class: "hint" },
        `graphlint ${r.lint.version ?? ""} — ${errors} error(s), ${warnings} warning(s).`,
      ),
    );
    // One caveat per rule rather than per finding: missing-schema fires on
    // every node of an observed graph, and the same sentence four times is a
    // sentence nobody reads.
    const explained = new Set<string>();
    for (const f of r.lint.findings) {
      const note = el("div", { class: `note ${f.severity === "error" ? "warn" : "info"}` });
      note.append(el("b", {}, f.rule), f.message);
      if (f.aboutTheInput && !explained.has(f.rule)) {
        note.append(el("span", { class: "note-aside" }, f.aboutTheInput));
        explained.add(f.rule);
      }
      sec.append(note);
    }
  }

  if (!r.estimate.ok) {
    sec.append(el("p", { class: "hint" }, r.estimate.detail));
  } else {
    const usd = r.estimate.usd;
    const kv = el("dl", { class: "kv" });
    if (r.estimate.agents) {
      kv.append(
        el("dt", {}, "agents"),
        el("dd", {}, `${r.estimate.agents.expected} expected (${r.estimate.agents.low}–${r.estimate.agents.high})`),
      );
    }
    if (usd) {
      kv.append(
        el("dt", {}, "predicted"),
        el("dd", {}, `${money(usd.expected)} (${money(usd.low)} – ${money(usd.high)})`),
      );
    }
    kv.append(
      el("dt", {}, "measured"),
      el("dd", {}, t.costUsd === null ? "unknown — no price for this model" : money(t.costUsd)),
    );
    sec.append(kv);
    if (r.gap) sec.append(el("p", { class: "hint" }, r.gap.note));
  }

  // A panel of verifiers that all asked one question has a fix, and the fix is
  // a command. What localflow deliberately does *not* do sits above it: the
  // measurement needs verdicts, and a transcript has none.
  if (r.noVerdicts) {
    sec.append(el("p", { class: "hint" }, r.noVerdicts));
    if (!r.lenses?.ok) {
      sec.append(el("p", { class: "hint" }, r.lenses?.detail ?? ""));
    } else {
      sec.append(
        el("p", { class: "hint" }, `decorrelate ${r.lenses.version ?? ""} — a ${r.lenses.domain} lens plan for that panel:`),
      );
      const list = el("div", { class: "lenses" });
      for (const l of r.lenses.lenses) {
        const item = el("div", { class: "lens" });
        const head = el("div", { class: "lens-head" });
        head.append(el("span", { class: "lens-key" }, l.key));
        if (l.model) head.append(el("span", { class: "lens-model" }, shortModel(l.model)));
        item.append(head, el("div", { class: "lens-q" }, l.question));
        if (l.oracleHint) item.append(el("div", { class: "lens-oracle" }, `oracle: ${l.oracleHint}`));
        list.append(item);
      }
      sec.append(list);
      sec.append(el("p", { class: "hint" }, "Pick a domain that fits the work: decorrelate lenses <domain>."));
    }
  }

  body.append(sec);
}

// ---- drawer -----------------------------------------------------------------

async function openDrawer(id: string): Promise<void> {
  const t = board?.tasks.find((x) => x.id === id);
  if (!t) return;
  selected = id;
  $("#d-title").textContent = t.title;
  const body = $("#d-body");
  body.replaceChildren();

  const kv = el("dl", { class: "kv" });
  const add = (k: string, v: string) => {
    kv.append(el("dt", {}, k), el("dd", {}, v));
  };
  add("lane", t.lane);
  add("status", t.status);
  add("session", t.id);
  if (t.model) add("model", t.model);
  if (t.effort) add("effort", t.effort);
  if (t.cwd) add("cwd", t.cwd);
  if (t.branch) add("branch", t.branch);
  if (t.pid) add("pid", String(t.pid));
  add("turns", String(t.turns));
  add("tokens", `${tokens(t.usage.output)} out · ${tokens(t.usage.cacheRead)} cached in · ${tokens(t.usage.input)} fresh in`);
  add("cost", t.costUsd === null ? "unknown — no price for this model" : money(t.costUsd));
  add("cache", t.cacheHitRate === null ? "—" : `${(t.cacheHitRate * 100).toFixed(1)}% of input from cache`);
  if (t.lane === "ended") {
    add("outcome", t.outcome === "errors-seen" ? "tool errors were seen" : "not recorded");
  }
  body.append(el("section", { class: "sec" }, el("h4", {}, "session"), kv));

  if (t.lastPrompt) {
    body.append(
      el("section", { class: "sec" }, el("h4", {}, "last prompt"), el("pre", { class: "prompt" }, t.lastPrompt)),
    );
  }

  if (t.queue.length) {
    const list = el("div", { class: "tools" });
    t.queue.forEach((q, i) => list.append(el("div", { class: "prompt" }, `${i + 1}. ${q}`)));
    body.append(el("section", { class: "sec" }, el("h4", {}, `queued prompts (${t.queue.length})`), list));
  }

  const toolEntries = Object.entries(t.tools).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length) {
    const max = toolEntries[0]![1];
    const list = el("div", { class: "tools" });
    for (const [name, n] of toolEntries.slice(0, 12)) {
      list.append(
        el(
          "div",
          { class: "tool" },
          el("span", {}, name),
          el("div", { class: "bar" }, el("i", { style: `width:${(n / max) * 100}%` } as never)),
          el("span", { class: "n" }, String(n)),
        ),
      );
    }
    body.append(el("section", { class: "sec" }, el("h4", {}, "tool calls"), list));
  }

  // The graph and the notes about it come from one request. They used to be two
  // things — a picture drawn from the card's own fan-outs, and notes fetched
  // afterwards — which meant the picture and the rules that judge it could
  // disagree about what they were looking at.
  let detail: GraphDetail | null = null;
  try {
    const res = await fetch(`/api/task/${encodeURIComponent(t.id)}/graph`);
    if (res.ok) detail = (await res.json()) as GraphDetail;
  } catch {
    /* the graph is a nicety; the drawer is still useful without it */
  }

  // The drawer's inner width, so the layout can decide between fitting and
  // scrolling rather than scaling the type away. clientWidth includes the
  // padding, and laying out into padding is how a layer ends up under the edge
  // of the panel — so the padding comes off before it is used.
  const room = innerWidthOf($("#d-body"));
  const g = graphView(t, detail?.spec ?? null, room);
  if (g) {
    const head = el("div", { class: "sec-head" }, el("h4", {}, "the graph that ran"));
    // A wide fan-out does not fit a 600px drawer at any type size worth
    // reading, so the graph gets somewhere to be looked at properly rather
    // than being shrunk until it is a texture.
    const expand = el("button", { class: "btn btn-quiet" }, "expand");
    expand.addEventListener("click", () => expandGraph(t, detail?.spec ?? null));
    head.append(expand);
    body.append(
      el(
        "section",
        { class: "sec" },
        head,
        g,
        el(
          "p",
          { class: "hint" },
          "Agent calls issued in one message run in parallel; calls in separate messages ran one after another. Shape is measured — whether a barrier was needed is not visible here.",
        ),
      ),
    );
  }

  body.append(el("section", { class: "sec" }, el("h4", {}, "actions"), actionButtons(t)));

  if (detail?.notes.length) {
    const sec = el("section", { class: "sec" }, el("h4", {}, "notes on this run"));
    for (const n of detail.notes) {
      sec.append(el("div", { class: `note ${n.level}` }, el("b", {}, n.rule), n.message));
    }
    body.append(sec);
  }

  // The rest of the family, on the same graph. Appended last and fetched
  // separately: it costs two subprocesses, and the drawer should not wait on
  // them to show what it already knows.
  if (detail?.spec) void appendReview(body, t);

  $("#drawer").hidden = false;
  $("#scrim").hidden = false;
}

function actionButtons(t: Task): HTMLElement {
  const wrap = el("div", { class: "actions" });
  if (!actionsEnabled) {
    return el(
      "p",
      { class: "hint" },
      "localflow is read-only. Restart it with --allow-actions to reprompt, reroute or stop a session from here.",
    );
  }
  if (t.source === "otter") {
    return el("p", { class: "hint" }, "This is an Otter job. localflow shows it but does not drive it.");
  }
  if (t.device) {
    // Watching a machine and steering it are different grants, and this board
    // only has the first. Saying where the session is beats a button that
    // resumes the wrong thing.
    return el(
      "p",
      { class: "hint" },
      `This session is on ${t.device}. localflow watches that machine read-only — ` +
        "reprompt, reroute and stop act on this one, so they are not offered here.",
    );
  }

  const reprompt = el("button", { class: "btn primary" }, "Reprompt");
  reprompt.onclick = () => openDialog("reprompt", t);
  const reroute = el("button", { class: "btn" }, "Reroute to another model");
  reroute.onclick = () => openDialog("reroute", t);
  wrap.append(reprompt, reroute);

  if (t.pid) {
    const stop = el("button", { class: "btn danger" }, "Interrupt");
    stop.onclick = async () => {
      const r = await post("/api/actions/stop", { sessionId: t.id });
      toast(r.detail ?? r.error ?? "done", r.ok ? "ok" : "err");
    };
    wrap.append(stop);
  }

  if (t.status === "busy") {
    wrap.append(
      el(
        "p",
        { class: "hint" },
        "This session is mid-turn. There is no supported way to inject a prompt into a running turn, so Reprompt will refuse — fork it with Reroute instead.",
      ),
    );
  }
  return wrap;
}

function closeDrawer(): void {
  selected = null;
  $("#drawer").hidden = true;
  $("#scrim").hidden = true;
}

// ---- dialog -----------------------------------------------------------------

type Mode = "spawn" | "reprompt" | "reroute";
let dialogMode: Mode = "spawn";
let dialogTask: Task | null = null;

function openDialog(mode: Mode, t?: Task): void {
  dialogMode = mode;
  dialogTask = t ?? null;
  const dlg = $<HTMLDialogElement>("#dlg");
  $("#dlg-err").hidden = true;
  ($("#f-prompt") as HTMLTextAreaElement).value = "";

  const titles: Record<Mode, string> = {
    spawn: "New task",
    reprompt: "Reprompt this session",
    reroute: "Reroute into a fork",
  };
  const subs: Record<Mode, string> = {
    spawn: "Starts a background Claude Code agent. It appears on the board within one poll.",
    reprompt: "Adds another turn to this session. Refused while the session is mid-turn.",
    reroute:
      "Forks the conversation into a new session on a different model, agent or effort level. The original is left exactly as it is.",
  };
  $("#dlg-title").textContent = titles[mode];
  $("#dlg-sub").textContent = subs[mode];
  $("#l-cwd").hidden = mode !== "spawn";
  ($("#dlg-go") as HTMLButtonElement).textContent = mode === "spawn" ? "Start" : "Send";
  if (mode === "reroute") {
    ($("#f-prompt") as HTMLTextAreaElement).placeholder = "Optional. Blank continues from where the session left off.";
  } else {
    ($("#f-prompt") as HTMLTextAreaElement).placeholder = "What should it do?";
  }
  if (mode === "spawn" && !($("#f-cwd") as HTMLInputElement).value) {
    ($("#f-cwd") as HTMLInputElement).value = board?.tasks[0]?.cwd ?? "";
  }
  dlg.showModal();
}

interface ActionReply {
  ok?: boolean;
  detail?: string;
  error?: string;
}

async function post(path: string, body: unknown): Promise<ActionReply> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ActionReply;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function wireDialog(): void {
  const dlg = $<HTMLDialogElement>("#dlg");
  $("#dlg-form").addEventListener("submit", async (ev) => {
    const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== "go") return;
    const prompt = ($("#f-prompt") as HTMLTextAreaElement).value;
    const model = ($("#f-model") as HTMLSelectElement).value || undefined;
    const effort = ($("#f-effort") as HTMLSelectElement).value || undefined;

    if (dialogMode === "spawn") {
      const cwd = ($("#f-cwd") as HTMLInputElement).value;
      const r = await post("/api/actions/spawn", { prompt, cwd, model, effort });
      toast(r.detail ?? r.error ?? "done", r.ok ? "ok" : "err");
    } else if (dialogMode === "reprompt" && dialogTask) {
      const r = await post("/api/actions/reprompt", { sessionId: dialogTask.id, prompt });
      toast(r.detail ?? r.error ?? "done", r.ok ? "ok" : "err");
    } else if (dialogMode === "reroute" && dialogTask) {
      const r = await post("/api/actions/reroute", { sessionId: dialogTask.id, prompt, model, effort });
      toast(r.detail ?? r.error ?? "done", r.ok ? "ok" : "err");
    }
    dlg.close();
  });
}

// ---- drag and drop ----------------------------------------------------------

/**
 * Dragging a card means asking for the action that would put it in that lane.
 *
 * Most moves have no such action — you cannot drag a session into "running",
 * because what makes a session run is having something to do. Rather than
 * silently snapping the card back, the lane refuses in red and says why. A board
 * that pretends every column is reachable is a board that lies about what it can
 * do.
 */
function dropIntent(t: Task, lane: Lane): { ok: true; run: () => void } | { ok: false; why: string } {
  if (!actionsEnabled) return { ok: false, why: "localflow is read-only — restart with --allow-actions" };
  if (t.source === "otter") return { ok: false, why: "Otter jobs are shown here, not driven from here" };
  if (lane === t.lane) return { ok: false, why: "already there" };

  if (lane === "ended") {
    if (!t.pid) return { ok: false, why: "this session has already ended" };
    return {
      ok: true,
      run: async () => {
        const r = await post("/api/actions/stop", { sessionId: t.id });
        toast(r.detail ?? r.error ?? "done", r.ok ? "ok" : "err");
      },
    };
  }
  if (lane === "running" || lane === "queued") {
    if (t.status === "busy") return { ok: false, why: "already running" };
    return { ok: true, run: () => openDialog("reprompt", t) };
  }
  return { ok: false, why: "nothing on this machine makes a session wait on you — that is its own doing" };
}

function wireDnD(): void {
  let dragId: string | null = null;

  document.addEventListener("dragstart", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".card");
    if (!c) return;
    dragId = c.dataset.id!;
    c.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", dragId);
  });
  document.addEventListener("dragend", () => {
    dragId = null;
    document.querySelectorAll(".dragging").forEach((c) => c.classList.remove("dragging"));
    document.querySelectorAll(".drop-target,.drop-refuse").forEach((l) => l.classList.remove("drop-target", "drop-refuse"));
  });
  document.addEventListener("dragover", (e) => {
    const lane = (e.target as HTMLElement).closest<HTMLElement>(".lane");
    if (!lane || !dragId) return;
    const t = board?.tasks.find((x) => x.id === dragId);
    if (!t) return;
    const target = [...lane.classList].find((c) => c.startsWith("lane-"))?.slice(5) as Lane | undefined;
    if (!target) return;
    const intent = dropIntent(t, target);
    e.preventDefault();
    lane.classList.toggle("drop-target", intent.ok);
    lane.classList.toggle("drop-refuse", !intent.ok);
  });
  document.addEventListener("dragleave", (e) => {
    (e.target as HTMLElement).closest(".lane")?.classList.remove("drop-target", "drop-refuse");
  });
  document.addEventListener("drop", (e) => {
    const lane = (e.target as HTMLElement).closest<HTMLElement>(".lane");
    if (!lane || !dragId) return;
    e.preventDefault();
    const t = board?.tasks.find((x) => x.id === dragId);
    const target = [...lane.classList].find((c) => c.startsWith("lane-"))?.slice(5) as Lane | undefined;
    if (!t || !target) return;
    const intent = dropIntent(t, target);
    if (intent.ok) intent.run();
    else toast(`Cannot move that here: ${intent.why}.`, "err");
  });
}

// ---- wiring -----------------------------------------------------------------

function apply(b: Board): void {
  if (b.error) {
    $("#live").className = "pill live off";
    $("#live").replaceChildren(el("i", {} as never), b.error.slice(0, 90));
    return;
  }
  board = b;
  renderTotals(b);
  renderBoard(b);
  $("#live").className = "pill live on";
  $("#live").replaceChildren(el("i", {} as never), `live · ${new Date(b.generatedAt).toLocaleTimeString()}`);
  if (selected) void openDrawer(selected);
}

/**
 * One fetch instead of a live stream.
 *
 * `?snapshot` renders the board once and leaves no open connection. It exists
 * because a page holding an EventSource never finishes loading as far as a
 * headless browser is concerned, so screenshots — for the docs, and for checking
 * that the thing actually looks right — hang forever without it.
 */
async function once(): Promise<void> {
  try {
    const res = await fetch("/api/board");
    apply((await res.json()) as Board);
    $("#live").className = "pill live";
    $("#live").replaceChildren(el("i", {} as never), "snapshot");
  } catch (e) {
    $("#live").className = "pill live off";
    $("#live").replaceChildren(el("i", {} as never), (e as Error).message);
  }
}

function connect(): void {
  const params = new URLSearchParams(location.search);
  if (params.has("snapshot")) {
    void once().then(() => {
      // `?open=<id-prefix>` opens a card straight away, so a screenshot can show
      // the drawer without anyone having to click it.
      const want = params.get("open");
      if (want) {
        const hit = board?.tasks.find((t) => t.id.startsWith(want) || t.name === want);
        if (hit) void openDrawer(hit.id);
      }
    });
    return;
  }
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      apply(JSON.parse(m.data) as Board);
    } catch {
      /* a malformed frame is not worth tearing the page down over */
    }
  };
  es.onerror = () => {
    $("#live").className = "pill live off";
    $("#live").replaceChildren(el("i", {} as never), "reconnecting");
  };
}

async function init(): Promise<void> {
  try {
    const h = (await (await fetch("/api/health")).json()) as { actions: boolean; otter: string | null };
    actionsEnabled = Boolean(h.actions);
    $("#mode").textContent = actionsEnabled ? "actions armed" : "read-only";
    $("#mode").className = actionsEnabled ? "pill armed" : "pill";
    ($("#new-task") as HTMLButtonElement).hidden = !actionsEnabled;
    $("#pricing-note").textContent = h.otter ? `federated with Otter at ${h.otter}` : "";
  } catch {
    /* the board still renders; the badge just stays at its default */
  }

  document.addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>(".card");
    if (c) void openDrawer(c.dataset.id!);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
    const c = document.activeElement?.closest<HTMLElement>(".card");
    if (c && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      void openDrawer(c.dataset.id!);
    }
  });
  $("#d-close").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  $("#new-task").addEventListener("click", () => openDialog("spawn"));
  wireViews();
  wireWorkflows();
  wireDialog();
  wireDnD();
  connect();
  // Devices are polled, not streamed: reaching six machines over ssh to redraw a
  // panel every two seconds would cost more than the panel is worth. Once at
  // boot, then on a slow timer.
  void renderDevices();
  setInterval(() => void renderDevices(), 30_000);
}

void init();


/* ---------------------------------------------------------------------------
 * Metrics and the session archive.
 *
 * Both are pull-on-demand rather than pushed down the board's event stream: the
 * board updates every two seconds and neither of these changes at that rate, so
 * streaming them would be a lot of bytes to redraw a chart that looks the same.
 * ------------------------------------------------------------------------- */

type View = "board" | "workflows" | "metrics" | "sessions";

interface Slice { key: string; sessions: number; usage: Usage; costUsd: number | null; unpriced: number }
interface WaterTriple { low: number; mid: number; high: number }
interface WaterPayload {
  ok: boolean; detail: string; version?: string; factorsVersion?: string;
  total: WaterTriple; region: string; includeEmbodied: boolean;
  byModel: { model: string; ml: WaterTriple; tier?: string; assumed: boolean; assumptions: string[] }[];
  unknown: { model: string; reason: string }[];
  assumedModels: string[];
}

interface BurnWindow {
  windowMs: number; from: number; to: number; sessions: number; usage: Usage;
  costUsd: number | null; unpriced: number; straddling: number; sampleMs: number;
  costPerHour: number | null; tokensPerHour: number | null;
  costIsFloor: boolean; thin: boolean; note: string;
}

interface Block {
  startedAt: number; endsAt: number; active: boolean; sessions: number; usage: Usage;
  costUsd: number | null; unpriced: number; straddling: number;
  costIsFloor: boolean; remainingMs: number;
  projectedCostUsd: number | null; projectedTokens: number | null; note: string;
}

interface MetricsPayload {
  buckets: { at: number; sessions: number; costUsd: number; unpriced: number; usage: Usage }[];
  bucketMs: number;
  byModel: Slice[];
  bySource: Slice[];
  byCwd: Slice[];
  totals: {
    sessions: number; usage: Usage; costUsd: number | null; unpricedSessions: number;
    cacheHitRate: number | null; toolErrors: number; toolCalls: number;
  };
  fanoutWidths: { width: number; count: number; failed: number }[];
  tools: { name: string; calls: number }[];
  burn: BurnWindow[];
  blocks: Block[];
  currentBlock: Block | null;
  water?: WaterPayload;
}

/** Millilitres in words. Mirrors src/water.ts so the CLI and the UI agree. */
function ml(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} L`;
  if (n >= 10) return `${n.toFixed(0)} mL`;
  return `${n.toFixed(2)} mL`;
}

function panel(heading: string, blurb: string, body: Node): HTMLElement {
  const wrap = el("div", { className: "panel" });
  wrap.append(el("h3", { textContent: heading }), el("p", { className: "blurb", textContent: blurb }), body as HTMLElement);
  return wrap;
}

/** A legend, always, for anything with more than one colour in it. */
function legend(keys: string[]): HTMLElement {
  const box = el("div", { className: "legend" });
  keys.forEach((k, i) => {
    const item = document.createElement("span");
    const dot = document.createElement("i");
    dot.style.background = i < 6 ? seriesColor(i) : OTHER;
    item.append(dot, document.createTextNode(k));
    box.append(item);
  });
  return box;
}

/** A duration ahead of us. `age` reads backwards from now; this one does not. */
function left(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Wall clock, local — the block boundary is something you look at a clock for. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Money that may be a lower bound.
 *
 * The `≥` is the whole point: a spend figure with unpriced work behind it is a
 * floor, and a dashboard that renders it as a total is under-reporting with a
 * straight face. Same rule the hatch on the bars follows, in one character.
 */
function floorMoney(usd: number | null, isFloor: boolean): string {
  if (usd === null) return "unknown";
  return isFloor ? `≥ ${money(usd)}` : money(usd);
}

function bucketLabel(at: number, width: number): string {
  const d = new Date(at);
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return width < 24 * 3600_000
    ? `${day} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : day;
}

/**
 * How fast it is going.
 *
 * Rates are the one metric here that is an extrapolation rather than a sum, so
 * every tile carries the sample it was computed from. `unknown` is a real
 * answer and appears whenever the server refused to state a rate — a burn rate
 * of `$0.00/h` for an hour of work nobody could price would be the confident
 * under-report this board exists not to produce.
 */
function burnPanel(m: MetricsPayload): HTMLElement {
  const body = document.createElement("div");
  const row = el("div", { className: "stat-row" });
  for (const w of m.burn) {
    const label = w.windowMs <= 3600_000 ? "Last hour" : `Last ${Math.round(w.windowMs / 3600_000)}h`;
    const note = [
      w.tokensPerHour === null ? null : `${tokens(Math.round(w.tokensPerHour))} tokens/h`,
      `${w.sessions} session${w.sessions === 1 ? "" : "s"}`,
      w.thin ? "thin sample" : null,
      w.straddling ? "bunched" : null,
    ].filter((x): x is string => x !== null);
    row.append(
      statTile(
        label,
        w.costPerHour === null ? "unknown" : `${floorMoney(w.costPerHour, w.costIsFloor)}/h`,
        note.join(" · "),
      ),
    );
  }
  body.append(row);
  // The caveats come from the server verbatim rather than being re-derived
  // here, so the CLI and the board cannot end up disagreeing about them.
  for (const w of m.burn) {
    if (!w.note) continue;
    const label = w.windowMs <= 3600_000 ? "Last hour" : `Last ${Math.round(w.windowMs / 3600_000)}h`;
    body.append(el("p", { className: "blurb", textContent: `${label}: ${w.note}` }));
  }
  const panelEl = panel(
    "Burn rate",
    "Spend and tokens per hour, divided by the part of each window this board could actually see — never by the window itself. Ended sessions age off the board, so a long window is a floor.",
    body,
  );
  panelEl.classList.add("panel-wide");
  return panelEl;
}

/**
 * The five-hour block, which is the window the limit actually resets on.
 *
 * "Spent today" is the wrong denominator — the limit does not care what
 * midnight is. What matters is how much of the block is gone, what went into
 * it, and whether continuing at this rate lands past the end of it.
 */
function blockPanel(m: MetricsPayload): HTMLElement {
  const body = document.createElement("div");
  const cur = m.currentBlock;

  if (!cur) {
    const last = m.blocks.at(-1);
    body.append(
      el("p", {
        className: "blurb",
        textContent: last
          ? `No block is open — the last one reset ${age(last.endsAt)} ago. The next session starts a new one.`
          : "Nothing has run yet, so no block has opened.",
      }),
    );
  } else {
    const row = el("div", { className: "stat-row" });
    row.append(
      statTile(
        "Spent this block",
        floorMoney(cur.costUsd, cur.costIsFloor),
        `${cur.sessions} session${cur.sessions === 1 ? "" : "s"} since ${clock(cur.startedAt)}`,
      ),
      statTile("Resets in", left(cur.remainingMs), `at ${clock(cur.endsAt)}`),
      statTile(
        "Projected by reset",
        cur.projectedCostUsd === null ? "not yet" : floorMoney(cur.projectedCostUsd, cur.costIsFloor),
        cur.projectedTokens === null
          ? "too early in the block to project"
          : `${tokens(Math.round(cur.projectedTokens))} tokens at this rate`,
      ),
    );
    body.append(row);
    if (cur.note) body.append(el("p", { className: "blurb", textContent: cur.note }));
  }

  if (m.blocks.length) {
    body.append(
      timeBars(
        m.blocks.map((b) => ({
          at: b.startedAt,
          value: b.costUsd ?? 0,
          // Same hatch convention as the spend chart: sized to be visible, never
          // a claim about what the unpriced sessions would have cost.
          unpriced: b.unpriced ? Math.max((b.costUsd ?? 0) * 0.08, 0.5) : 0,
          label: `${bucketLabel(b.startedAt, 3600_000)} — ${clock(b.endsAt)}${b.active ? " (open)" : ""}`,
        })),
        { format: (n) => money(n) },
      ),
    );
  }

  // Deliberately not `panel-wide`, unlike the burn tiles above it: a handful of
  // blocks spread across the whole grid is five bars the width of a hand.
  return panel(
    "Five-hour block",
    "Usage limits reset on rolling five-hour blocks, and a block opens with the first session after the last one closed — not on a fixed grid. One bar per block, hatched where nobody could price the work.",
    body,
  );
}

async function renderMetrics(): Promise<void> {
  const host = $("#metrics");
  host.textContent = "";
  let m: MetricsPayload;
  try {
    m = (await (await fetch("/api/metrics")).json()) as MetricsPayload;
  } catch (e) {
    host.append(panel("Metrics", "Could not read the metrics.", document.createTextNode(String(e))));
    return;
  }

  const t = m.totals;
  const stats = el("div", { className: "stat-row" });
  stats.append(
    statTile("Sessions", String(t.sessions)),
    statTile("Output", tokens(t.usage.output)),
    statTile("Cached in", tokens(t.usage.cacheRead)),
    statTile(
      "Spend",
      money(t.costUsd),
      // The count of unpriced sessions rides with the figure rather than beside
      // it, because a total is only honest if you can see what it left out.
      t.unpricedSessions ? `${t.unpricedSessions} session(s) not included — no price known` : "every session priced",
    ),
    statTile(
      "Cache hit rate",
      t.cacheHitRate === null ? "unknown" : `${Math.round(t.cacheHitRate * 100)}%`,
      "share of input served from cache",
    ),
    statTile(
      "Tool errors",
      String(t.toolErrors),
      `${t.toolCalls.toLocaleString()} calls`,
    ),
  );
  host.append(stats);

  const grid = el("div", { className: "panel-grid" });

  // Rates first: "am I about to run out" is the question a board of running
  // agents is opened to answer, and the history below is context for it.
  grid.append(burnPanel(m), blockPanel(m));

  grid.append(
    panel(
      "Spend over time",
      `One bar per ${Math.round(m.bucketMs / 60000)} minutes. Hatched means work nobody could price — it happened, and no total above includes it.`,
      timeBars(
        m.buckets.map((b) => ({
          at: b.at,
          value: b.costUsd,
          // A bucket with unpriced sessions gets a hatch sized by session count
          // scaled onto the money axis — enough to be visible, never a claim
          // about how much it cost.
          unpriced: b.unpriced ? Math.max(b.costUsd * 0.08, 0.5) : 0,
          label: bucketLabel(b.at, m.bucketMs),
        })),
        { format: (n) => money(n) },
      ),
    ),
  );

  grid.append(
    panel(
      "Sessions over time",
      "How busy the machine was, in the same buckets.",
      timeBars(
        m.buckets.map((b) => ({ at: b.at, value: b.sessions, label: bucketLabel(b.at, m.bucketMs) })),
      ),
    ),
  );

  const modelRows = m.byModel.map((s) => ({
    key: shortModel(s.key) || s.key,
    value: s.usage.output + s.usage.input + s.usage.cacheRead,
    detail: s.costUsd === null ? "cost unknown" : money(s.costUsd),
    unpriced: s.costUsd === null,
  }));
  const models = document.createElement("div");
  models.append(breakdown(modelRows), legend(modelRows.slice(0, 6).map((r) => r.key)));
  grid.append(panel("By model", "Tokens handled, priced where a rate is known.", models));

  const srcRows = m.bySource.map((s) => ({
    key: s.key,
    value: s.sessions,
    detail: `${s.sessions} session${s.sessions === 1 ? "" : "s"}`,
  }));
  const sources = document.createElement("div");
  sources.append(breakdown(srcRows), legend(srcRows.slice(0, 6).map((r) => r.key)));
  grid.append(
    panel(
      "By tool",
      "Which agent produced the work. Add more in ~/.localflow/sources.json.",
      sources,
    ),
  );

  grid.append(
    panel(
      "By project",
      "Last two path segments of each session's working directory.",
      breakdown(
        m.byCwd.map((s) => ({
          key: s.key,
          value: s.usage.output,
          detail: s.costUsd === null ? "cost unknown" : money(s.costUsd),
          unpriced: s.costUsd === null,
        })),
      ),
    ),
  );

  grid.append(
    panel(
      "Observed fan-out",
      "How wide the parallelism actually got. Red is the share that came back with a tool error.",
      m.fanoutWidths.length
        ? histogram(m.fanoutWidths.map((f) => ({ bin: String(f.width), count: f.count, bad: f.failed })))
        : el("p", { className: "blurb", textContent: "No fan-outs recorded yet." }),
    ),
  );

  grid.append(
    panel(
      "Tools used",
      "Calls per tool across every session on the board.",
      breakdown(
        m.tools.map((t2) => ({ key: t2.name, value: t2.calls, detail: t2.calls.toLocaleString() })),
        { max: 8 },
      ),
    ),
  );

  if (m.water) host.append(waterPanel(m.water));

  host.append(grid);
}

/**
 * What the answers cost in freshwater, via soif.
 *
 * The range is never dropped. soif exists because published per-prompt figures
 * span two orders of magnitude — Google measured 0.26 mL for a median Gemini
 * prompt, Mistral's LCA reports 45 mL for a 400-token response — so a bare
 * midpoint would throw away the only honest part of the estimate.
 */
function waterPanel(w: WaterPayload): HTMLElement {
  if (!w.ok) {
    return panel("Water", w.detail, el("p", { className: "blurb", textContent: "No estimate." }));
  }

  const body = document.createElement("div");
  const hero = el("div", { className: "stat-row" });
  hero.append(
    statTile(
      "Freshwater",
      ml(w.total.mid),
      `range ${ml(w.total.low)} – ${ml(w.total.high)}`,
    ),
  );
  body.append(hero);

  body.append(
    breakdown(
      w.byModel.map((s) => ({
        key: `${shortModel(s.model) || s.model}${s.assumed ? " (assumed tier)" : ""}`,
        value: s.ml.mid,
        detail: ml(s.ml.mid),
        // An estimate resting on a guessed tier is drawn hollow, the same way an
        // unpriced model is: a tier is worth ~30x, so the two are not the same
        // claim and must not look alike.
        unpriced: s.assumed,
      })),
    ),
  );

  const notes: string[] = [];
  if (w.assumedModels.length) {
    notes.push(
      `soif had no factors for ${w.assumedModels.join(", ")} and assumed a capability tier — ` +
        "tier is worth roughly 30x across the range, so treat those rows as the weakest part of this total.",
    );
  }
  if (w.unknown.length) {
    notes.push(`${w.unknown.length} model(s) could not be estimated and are excluded from the total.`);
  }
  notes.push(
    `soif ${w.version ?? "?"}, factors ${w.factorsVersion ?? "?"}, region ${w.region}` +
      `${w.includeEmbodied ? ", including embodied manufacturing water" : ", operational water only"}. ` +
      "Estimates, not measurements — see soif's METHODOLOGY.md before quoting them.",
  );
  for (const n of notes) body.append(el("p", { className: "blurb", textContent: n }));

  return panel(
    "Water",
    "Cooling-tower evaporation plus the water consumed generating the electricity, estimated by soif from the same token counts as the spend above.",
    body,
  );
}

interface SessionRow {
  sessionId: string; cwd: string; bytes: number; updatedAt: number;
  live: boolean; status?: string; name?: string;
}

async function renderSessions(query = ""): Promise<void> {
  const body = $("#sess-body");
  body.textContent = "loading…";
  let data: { rows: SessionRow[]; total: number; truncated: number };
  try {
    data = await (await fetch(`/api/sessions?limit=300&q=${encodeURIComponent(query)}`)).json();
  } catch (e) {
    body.textContent = `could not read sessions: ${String(e)}`;
    return;
  }
  body.textContent = "";

  const table = document.createElement("table");
  table.className = "sess-table";
  table.innerHTML =
    "<thead><tr><th>session</th><th>where</th><th>size</th><th>last active</th><th>state</th></tr></thead>";
  const tbody = document.createElement("tbody");
  for (const r of data.rows) {
    const tr = document.createElement("tr");
    for (const text of [
      r.name ?? r.sessionId.slice(0, 8),
      tilde(r.cwd),
      r.bytes ? `${(r.bytes / 1e6).toFixed(1)} MB` : "—",
      age(r.updatedAt),
    ]) {
      tr.append(el("td", { textContent: text }));
    }
    const state = el("td", { textContent: r.live ? (r.status ?? "live") : "ended" });
    if (r.live) state.className = "sess-live";
    tr.append(state);
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);

  const note = el("p", { className: "blurb" });
  note.textContent = data.truncated
    ? `${data.rows.length} of ${data.total} — ${data.truncated} more not shown. Narrow the filter.`
    : `${data.total} session${data.total === 1 ? "" : "s"} on this machine.`;
  body.append(note);
}

const VIEWS: readonly View[] = ["board", "workflows", "metrics", "sessions"] as const;

/**
 * Which view the URL is asking for.
 *
 * The hash rather than a query parameter, so it composes with the `?snapshot`
 * and `?open=` parameters the screenshot path already uses instead of fighting
 * them for the search string.
 */
function viewFromLocation(): View {
  const want = location.hash.replace(/^#\/?/, "");
  return (VIEWS as readonly string[]).includes(want) ? (want as View) : "board";
}

type HistoryMode = "push" | "replace" | "none";

/**
 * Switch view, and put it in the URL.
 *
 * Views used to be swapped by setting a data attribute and nothing else, which
 * meant a view could not be linked, did not survive a refresh, and left the Back
 * button doing nothing on a page people leave open all day. A click pushes, so
 * Back walks between views; restoring from the URL applies without pushing, or
 * every restore would add another entry.
 */
function setView(view: View, history_: HistoryMode = "push"): void {
  document.body.dataset.view = view;
  for (const btn of document.querySelectorAll<HTMLElement>(".view-btn")) {
    btn.setAttribute("aria-selected", String(btn.dataset.view === view));
  }

  if (history_ !== "none") {
    // The board is the default, so it gets a bare URL rather than `#board`.
    const url = view === "board" ? location.pathname + location.search : `#${view}`;
    if (history_ === "push") history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }

  if (view === "workflows") void renderWorkflows();
  if (view === "metrics") void renderMetrics();
  if (view === "sessions") void renderSessions(($("#sess-q") as HTMLInputElement).value);
}

function wireViews(): void {
  setView(viewFromLocation(), "replace");
  for (const btn of document.querySelectorAll<HTMLElement>(".view-btn")) {
    btn.addEventListener("click", () => setView((btn.dataset.view ?? "board") as View));
  }
  // Back, Forward, and someone editing the hash by hand.
  addEventListener("popstate", () => setView(viewFromLocation(), "none"));
  addEventListener("hashchange", () => setView(viewFromLocation(), "none"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  $("#sess-q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => void renderSessions((e.target as HTMLInputElement).value), 200);
  });
}

// ---- devices ----------------------------------------------------------------
//
// The panel is deliberately quiet when the feature is off. A machine that never
// registered a device should not be told about a capability it is not using, and
// a board full of "remote disabled" banners teaches its reader to skip banners.

interface DeviceSession {
  name: string;
  createdAt: number | null;
  attached: boolean;
  windows: number;
}

interface DeviceRow {
  name: string;
  host: string;
  /** Null when nothing has asked this machine anything yet — not the same as "off". */
  reachable: boolean | null;
  detail: string;
  tmux: boolean;
  claude: boolean;
  sessions: DeviceSession[];
  monitored: boolean;
  cards: number;
  syncedAt: number | null;
  staleSince: number | null;
}

interface DevicesResponse {
  enabled: boolean;
  /** --allow-remote: work may be started on these machines. */
  canStart: boolean;
  /** --watch-remote: their sessions are on the board. */
  watching: boolean;
  devices: DeviceRow[];
  path: string;
  mirror: string | null;
  error: string | null;
}

async function renderDevices(): Promise<void> {
  const section = $("#devices");
  const body = $("#dev-body");
  let data: DevicesResponse;
  try {
    data = await (await fetch("/api/devices")).json();
  } catch {
    section.hidden = true;
    return;
  }

  // Off, or on with nothing declared: both mean "this box does not do remote",
  // and neither is a problem to report.
  if (!data.enabled || (data.devices.length === 0 && !data.error)) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  body.textContent = "";

  if (data.error) {
    const warn = el("p", { className: "degraded" });
    warn.textContent = data.error;
    body.append(warn);
  }

  for (const d of data.devices) {
    const row = el("div", { className: "dev-row" });
    const head = el("div", { className: "dev-head" });

    const dot = el("span", {
      className: `dev-dot ${d.reachable === null ? "unknown" : d.reachable ? "ok" : "off"}`,
    });
    const name = el("strong");
    name.textContent = d.name;
    const host = el("span", { className: "dev-host" });
    host.textContent = d.host;
    head.append(dot, name, host);

    // What this machine is to us. Watching and spawning are separate grants, so
    // a device can legitimately be one, the other, both, or neither, and the
    // row has to be able to say which.
    if (data.watching) {
      const watch = el("span", { className: `dev-watch${d.monitored ? "" : " off"}` });
      watch.textContent = !d.monitored
        ? "not monitored"
        : d.staleSince
          ? `${d.cards} card(s), last synced ${age(d.staleSince)} ago`
          : d.syncedAt
            ? `${d.cards} card(s) on the board`
            : "not synced yet";
      head.append(watch);
    }

    if (d.reachable === false) {
      // Asleep is the ordinary state of a laptop. Say what ssh said and move on.
      const why = el("span", { className: "dev-why" });
      why.textContent = d.detail || "unreachable";
      head.append(why);
    } else if (d.reachable === true && data.canStart && (!d.tmux || !d.claude)) {
      // Reachable but not equipped: name the missing piece, since the fix is a
      // one-line install on that machine rather than anything to do here.
      const missing = [!d.tmux && "tmux", !d.claude && "claude"].filter(Boolean).join(" and ");
      const why = el("span", { className: "dev-why" });
      why.textContent = `reachable, but ${missing} not on PATH`;
      head.append(why);
    }
    row.append(head);

    if (d.sessions.length) {
      const list = el("ul", { className: "dev-sessions" });
      for (const s of d.sessions) {
        const li = el("li");
        const label = el("span");
        label.textContent = s.createdAt ? `${s.name} — started ${age(s.createdAt)} ago` : s.name;
        li.append(label);

        // The attach command is text to copy, not a button. Handing someone a
        // command they run in their own terminal keeps the tty on their side.
        const cmd = el("code", { className: "dev-attach" });
        cmd.textContent = `ssh -t ${d.host} tmux attach -t ${s.name}`;
        li.append(cmd);

        const kill = el("button", { className: "btn btn-quiet" });
        kill.textContent = "kill";
        kill.addEventListener("click", async () => {
          kill.disabled = true;
          const reply = await post("/api/actions/remote-kill", { device: d.name, session: s.name });
          toast(reply.error ?? `${s.name} stopped`, reply.error ? "err" : "ok");
          await renderDevices();
        });
        li.append(kill);
        list.append(li);
      }
      row.append(list);
    } else if (d.reachable && data.canStart) {
      // Only claimable when we actually asked. In watch-only mode the tmux list
      // is never fetched, and "no sessions started from here" would be a claim
      // about something this board did not look at.
      const none = el("p", { className: "blurb" });
      none.textContent = "no sessions started from here";
      row.append(none);
    }

    body.append(row);
  }
}


/* ---------------------------------------------------------------------------
 * Workflows: the graph you write, rather than the one you ran
 *
 * Same visual language as the drawer's observed graph on purpose. A workflow
 * and the run it produced are the same kind of object — nodes, edges, a barrier
 * between groups — and drawing them differently would suggest they are not.
 *
 * The canvas lays out by longest path from a root, so the picture comes from
 * the edges rather than from stored coordinates. Nothing to drag means nothing
 * to leave stale: delete a node and the layout is still correct, which is not
 * true of any editor that remembers where you put things.
 * ------------------------------------------------------------------------- */

interface WfNode {
  id: string;
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  agent?: string;
  phase?: string;
  tier?: string;
  fanout?: { over: string; width: number };
}

interface WfEdge { from: string; to: string; channel?: string; barrier?: boolean; barrierReason?: string }

interface WfSpec {
  name: string;
  description?: string;
  cwd?: string;
  budget?: { usd?: number | null; tokens?: number | null };
  nodes: WfNode[];
  edges: WfEdge[];
}

interface NodeRun {
  id: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  index?: number;
  sessionId?: string;
  costUsd?: number;
  output?: string;
  detail?: string;
}

interface RunState {
  id: string;
  workflow: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "done" | "failed" | "refused";
  nodes: NodeRun[];
  detail: string;
  costUsd: number | null;
}

let wfSpec: WfSpec | null = null;
let wfSelected: string | null = null;
let wfDirty = false;
/** Latest state per node id, from the run stream. */
let wfRun: RunState | null = null;
let wfStream: EventSource | null = null;

const WF_NODE_W = 150;
const WF_NODE_H = 56;
const WF_GAP_X = 22;
const WF_LAYER_GAP = 66;

/** Longest path from a root: a node sits below everything it depends on. */
function wfLayers(spec: WfSpec): string[][] {
  const deps = new Map<string, string[]>();
  for (const n of spec.nodes) deps.set(n.id, []);
  for (const e of spec.edges ?? []) {
    if (deps.has(e.to) && deps.has(e.from)) deps.get(e.to)!.push(e.from);
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const of = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    // A cycle cannot be laid out, and the editor must survive one long enough
    // for you to fix it — validation is what refuses to *run* it.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = (deps.get(id) ?? []).reduce((a, p) => Math.max(a, of(p) + 1), 0);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const rows: string[][] = [];
  for (const n of spec.nodes) {
    const d = of(n.id);
    (rows[d] ??= []).push(n.id);
  }
  return rows.map((r) => r ?? []);
}

/** Where every node sits, in pixels. */
function wfLayout(spec: WfSpec, available: number) {
  const rows = wfLayers(spec);
  const widest = Math.max(1, ...rows.map((r) => r.length));
  const width = Math.max(available, widest * WF_NODE_W + (widest - 1) * WF_GAP_X + 48);
  const height = 24 + rows.length * WF_NODE_H + Math.max(0, rows.length - 1) * WF_LAYER_GAP + 24;
  const at = new Map<string, { x: number; y: number }>();

  rows.forEach((row, r) => {
    const rowW = row.length * WF_NODE_W + (row.length - 1) * WF_GAP_X;
    const x0 = (width - rowW) / 2;
    row.forEach((id, i) => {
      at.set(id, { x: x0 + i * (WF_NODE_W + WF_GAP_X), y: 24 + r * (WF_NODE_H + WF_LAYER_GAP) });
    });
  });
  return { at, width, height, rows };
}

/** Per-node run state, collapsed from the per-child rows the runner emits. */
function wfStateOf(id: string): NodeRun["state"] | null {
  const rows = (wfRun?.nodes ?? []).filter((n) => n.id === id);
  if (!rows.length) return null;
  if (rows.some((r) => r.state === "failed")) return "failed";
  if (rows.some((r) => r.state === "running")) return "running";
  if (rows.some((r) => r.state === "skipped")) return "skipped";
  return rows.every((r) => r.state === "done") ? "done" : "pending";
}

function wfCanvas(spec: WfSpec, available: number): SVGSVGElement {
  const { at, width, height } = wfLayout(spec, available);
  const root = svg("svg", { width, height, class: "wf-svg" });

  // Edges first so the boxes sit on top of them.
  for (const e of spec.edges ?? []) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + WF_NODE_W / 2;
    const y1 = a.y + WF_NODE_H;
    const x2 = b.x + WF_NODE_W / 2;
    const y2 = b.y;
    const mid = (y1 + y2) / 2;
    const path = svg("path", {
      class: `wf-edge${e.barrier ? " barrier" : ""}`,
      d: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`,
      "marker-end": "url(#wf-arrow)",
    });
    titled(path, e.barrierReason ?? (e.barrier ? "barrier" : e.channel ?? ""));
    root.append(path);
  }

  const defs = svg("defs", {});
  const marker = svg("marker", {
    id: "wf-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4,
    markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse",
  });
  marker.append(svg("path", { d: "M 0 1 L 7 4 L 0 7 z", class: "wf-arrow" }));
  defs.append(marker);
  root.append(defs);

  for (const n of spec.nodes) {
    const p = at.get(n.id);
    if (!p) continue;
    const state = wfStateOf(n.id);
    const g = svg("g", {
      class: `wf-n${state ? ` ${state}` : ""}${wfSelected === n.id ? " sel" : ""}`,
      role: "button",
      tabindex: 0,
    });
    g.append(svg("rect", { x: p.x, y: p.y, width: WF_NODE_W, height: WF_NODE_H, rx: 8 }));

    const id = svg("text", { class: "wf-id", x: p.x + 11, y: p.y + 20 });
    id.textContent = n.id;
    g.append(id);

    const meta = svg("text", { class: "wf-meta", x: p.x + 11, y: p.y + 36 });
    meta.textContent = [n.model, n.fanout ? `×${n.fanout.width}` : null].filter(Boolean).join(" · ") || "default model";
    g.append(meta);

    const prompt = svg("text", { class: "wf-prompt", x: p.x + 11, y: p.y + 49 });
    prompt.textContent = fitLabel(n.prompt.replace(/\s+/g, " "), WF_NODE_W - 8, 1)[0] ?? "";
    g.append(prompt);

    titled(g, n.prompt);
    g.addEventListener("click", () => {
      wfSelected = n.id;
      renderWorkflowBody();
    });
    root.append(g);
  }
  return root;
}

/* ---- the tab ------------------------------------------------------------ */

async function renderWorkflows(): Promise<void> {
  const items = $("#wf-items");
  items.textContent = "loading…";
  let data: { workflows: { name: string; error?: string; spec?: WfSpec }[]; dir: string };
  try {
    data = await (await fetch("/api/workflows")).json();
  } catch (e) {
    items.textContent = `could not read workflows: ${String(e)}`;
    return;
  }

  $("#wf-dir").textContent = `Files in ${tilde(data.dir)} — plain graph specs, diffable and reviewable.`;
  items.textContent = "";
  if (!data.workflows.length) {
    items.append(el("p", { class: "blurb" }, "None yet. `new` starts one."));
  }
  for (const w of data.workflows) {
    const row = el("button", { class: `wf-item${wfSpec?.name === w.name ? " on" : ""}` });
    row.append(el("span", { class: "wf-item-name" }, w.name));
    if (w.error) row.append(el("span", { class: "wf-item-bad" }, "unreadable"));
    else row.append(el("span", { class: "wf-item-n" }, `${w.spec?.nodes.length ?? 0} nodes`));
    row.addEventListener("click", () => void openWorkflow(w.name));
    items.append(row);
  }

  if (!wfSpec && data.workflows[0]?.spec) await openWorkflow(data.workflows[0].name);
  else renderWorkflowBody();
  watchRuns();
}

async function openWorkflow(name: string): Promise<void> {
  try {
    const r = await fetch(`/api/workflows/${encodeURIComponent(name)}`);
    if (!r.ok) return;
    const { spec } = (await r.json()) as { spec: WfSpec };
    wfSpec = spec;
    wfSelected = spec.nodes[0]?.id ?? null;
    wfDirty = false;
    wfRun = null;
    renderWorkflowBody();
    void renderWorkflows();
  } catch {
    /* the list is still usable */
  }
}

function renderWorkflowBody(): void {
  const canvas = $("#wf-canvas");
  canvas.textContent = "";
  $("#wf-name").textContent = wfSpec ? `${wfSpec.name}${wfDirty ? " ·" : ""}` : "—";

  if (!wfSpec) {
    canvas.append(el("p", { class: "blurb" }, "Pick a workflow, or start a new one."));
    return;
  }
  canvas.append(wfCanvas(wfSpec, innerWidthOf(canvas, 760)));
  renderInspector();
}

/** The panel that edits whatever is selected. */
function renderInspector(): void {
  const host = $("#wf-inspect");
  host.textContent = "";
  if (!wfSpec) return;

  const add = el("div", { class: "wf-actions" });
  const addNode = el("button", { class: "btn btn-quiet" }, "+ node");
  addNode.addEventListener("click", () => {
    const id = uniqueNodeId(wfSpec!);
    wfSpec!.nodes.push({ id, prompt: "Describe what this step should do." });
    // Wired to whatever is selected, because an unconnected node is a node
    // that runs first and alone — rarely what you meant by adding it here.
    if (wfSelected) wfSpec!.edges.push({ from: wfSelected, to: id });
    wfSelected = id;
    wfDirty = true;
    renderWorkflowBody();
  });
  add.append(addNode);
  host.append(add);

  const n = wfSpec.nodes.find((x) => x.id === wfSelected);
  if (!n) {
    host.append(el("p", { class: "blurb" }, "Select a node to edit it."));
    return;
  }

  const field = (label: string, value: string, onInput: (v: string) => void, area = false) => {
    const wrap = el("label", { class: "wf-field" }, el("span", {}, label));
    const input = area ? document.createElement("textarea") : document.createElement("input");
    if (area) (input as HTMLTextAreaElement).rows = 6;
    input.value = value;
    input.addEventListener("input", () => {
      onInput(input.value);
      wfDirty = true;
      $("#wf-name").textContent = `${wfSpec!.name} ·`;
    });
    wrap.append(input);
    host.append(wrap);
  };

  field("id", n.id, (v) => {
    const from = n.id;
    n.id = v;
    for (const e of wfSpec!.edges) {
      if (e.from === from) e.from = v;
      if (e.to === from) e.to = v;
    }
    wfSelected = v;
  });
  field("prompt — {{input}} carries the nodes above", n.prompt, (v) => (n.prompt = v), true);
  field("model", n.model ?? "", (v) => (n.model = v || undefined));
  field("effort", n.effort ?? "", (v) => (n.effort = v || undefined));
  field("working directory", n.cwd ?? "", (v) => (n.cwd = v || undefined));
  field("fan-out width", String(n.fanout?.width ?? 1), (v) => {
    const w = Number(v);
    n.fanout = w > 1 ? { over: "agents", width: w } : undefined;
  });

  const depends = el("div", { class: "wf-field" }, el("span", {}, "runs after"));
  const picker = document.createElement("select");
  picker.multiple = true;
  picker.size = Math.min(5, Math.max(2, wfSpec.nodes.length));
  const current = new Set(wfSpec.edges.filter((e) => e.to === n.id).map((e) => e.from));
  for (const other of wfSpec.nodes) {
    if (other.id === n.id) continue;
    const opt = document.createElement("option");
    opt.value = other.id;
    opt.textContent = other.id;
    opt.selected = current.has(other.id);
    picker.append(opt);
  }
  picker.addEventListener("change", () => {
    const want = new Set([...picker.selectedOptions].map((o) => o.value));
    wfSpec!.edges = wfSpec!.edges.filter((e) => e.to !== n.id || want.has(e.from));
    for (const from of want) {
      if (!wfSpec!.edges.some((e) => e.from === from && e.to === n.id)) {
        wfSpec!.edges.push({ from, to: n.id, barrier: true, barrierReason: "declared: this step waits for it" });
      }
    }
    wfDirty = true;
    renderWorkflowBody();
  });
  depends.append(picker);
  host.append(depends);

  const del = el("button", { class: "btn btn-quiet danger" }, "delete node");
  del.addEventListener("click", () => {
    wfSpec!.nodes = wfSpec!.nodes.filter((x) => x.id !== n.id);
    wfSpec!.edges = wfSpec!.edges.filter((e) => e.from !== n.id && e.to !== n.id);
    wfSelected = wfSpec!.nodes[0]?.id ?? null;
    wfDirty = true;
    renderWorkflowBody();
  });
  host.append(del);

  const run = (wfRun?.nodes ?? []).filter((r) => r.id === n.id);
  if (run.length) {
    const sec = el("div", { class: "wf-runinfo" }, el("h4", {}, "last run"));
    for (const r of run) {
      const line = el("div", { class: `wf-runline ${r.state}` });
      line.textContent =
        `${r.state}${r.index !== undefined ? ` #${r.index + 1}` : ""}` +
        `${r.costUsd !== undefined ? ` · ${money(r.costUsd)}` : ""}` +
        `${r.detail ? ` · ${r.detail}` : ""}`;
      if (r.output) titledDiv(line, r.output);
      sec.append(line);
    }
    host.append(sec);
  }
}

function titledDiv(node: HTMLElement, text: string): void {
  node.title = text;
}

function uniqueNodeId(spec: WfSpec): string {
  for (let i = spec.nodes.length + 1; ; i++) {
    const id = `step-${i}`;
    if (!spec.nodes.some((n) => n.id === id)) return id;
  }
}


/* ---- check, save, run --------------------------------------------------- */

/**
 * Run progress, live.
 *
 * One stream for the whole tab rather than one per run: a run is minutes long
 * and a canvas left open should pick up whatever is happening without being
 * told to look.
 */
function watchRuns(): void {
  if (wfStream) return;
  wfStream = new EventSource("/api/workflows/runs/events");
  wfStream.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data) as
        | { type: "run"; run: RunState }
        | { type: "node"; run: string; node: NodeRun };
      if (e.type === "run") {
        wfRun = e.run;
      } else if (wfRun) {
        // The runner emits a row per child, and a "running" row before them.
        // Replace the placeholder rather than stacking it up.
        const at = wfRun.nodes.findIndex(
          (n) => n.id === e.node.id && (n.index ?? -1) === (e.node.index ?? -1) && n.state === "running",
        );
        if (at >= 0) wfRun.nodes[at] = e.node;
        else wfRun.nodes.push(e.node);
      } else {
        wfRun = {
          id: e.run, workflow: wfSpec?.name ?? "", startedAt: Date.now(),
          state: "running", nodes: [e.node], detail: "", costUsd: null,
        };
      }
      if (document.body.dataset.view === "workflows") {
        renderRunStatus();
        renderWorkflowBody();
      }
    } catch {
      /* a malformed frame is not worth tearing the tab down over */
    }
  };
  wfStream.onerror = () => {
    $("#wf-status").textContent = "run stream disconnected";
  };
}

function renderRunStatus(): void {
  const el0 = $("#wf-status");
  if (!wfRun) {
    el0.textContent = "";
    return;
  }
  const done = wfRun.nodes.filter((n) => n.state === "done").length;
  const bits = [
    wfRun.state,
    `${done}/${wfRun.nodes.length || "?"} done`,
    wfRun.costUsd === null ? null : money(wfRun.costUsd),
  ].filter(Boolean);
  el0.textContent = bits.join(" · ");
  el0.className = `wf-status ${wfRun.state}`;
}

/** The report strip under the canvas: what the family said, or why it refused. */
function wfReport(lines: { level: "ok" | "warn" | "bad"; text: string }[]): void {
  const host = $("#wf-report");
  host.textContent = "";
  host.hidden = !lines.length;
  for (const l of lines) host.append(el("div", { class: `wf-line ${l.level}` }, l.text));
}

function wireWorkflows(): void {
  $("#wf-new").addEventListener("click", () => {
    wfSpec = {
      name: `workflow-${Math.random().toString(36).slice(2, 6)}`,
      description: "",
      cwd: "",
      nodes: [{ id: "step-1", prompt: "Describe what this step should do." }],
      edges: [],
    };
    wfSelected = "step-1";
    wfDirty = true;
    wfRun = null;
    renderWorkflowBody();
  });

  $("#wf-save").addEventListener("click", async () => {
    if (!wfSpec) return;
    const r = await fetch(`/api/workflows/${encodeURIComponent(wfSpec.name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wfSpec),
    });
    const body = (await r.json()) as { ok?: boolean; detail?: string; problems?: { where?: string; message: string }[] };
    wfDirty = false;
    renderWorkflowBody();
    void renderWorkflows();
    // Saved even when it does not validate — a draft you cannot save is a
    // draft you lose — so the problems are reported rather than blocking.
    wfReport([
      { level: body.ok ? "ok" : "bad", text: body.detail ?? "saved" },
      ...(body.problems ?? []).map((p) => ({
        level: "warn" as const,
        text: p.where ? `${p.where}: ${p.message}` : p.message,
      })),
    ]);
  });

  $("#wf-check").addEventListener("click", async () => {
    if (!wfSpec) return;
    wfReport([{ level: "ok", text: "asking graphlint and preflight…" }]);
    const r = await fetch(`/api/workflows/${encodeURIComponent(wfSpec.name)}/check`, { method: "POST" });
    if (!r.ok) return wfReport([{ level: "bad", text: "save it first — check reads the file on disk" }]);
    const body = (await r.json()) as {
      problems: { where?: string; message: string }[];
      lint: { ok: boolean; skipped: boolean; detail: string };
      budget: { ok: boolean; skipped: boolean; detail: string };
    };
    wfReport([
      ...body.problems.map((p) => ({
        level: "bad" as const,
        text: p.where ? `${p.where}: ${p.message}` : p.message,
      })),
      { level: body.lint.ok ? (body.lint.skipped ? "warn" : "ok") : "bad", text: body.lint.detail },
      { level: body.budget.ok ? (body.budget.skipped ? "warn" : "ok") : "bad", text: body.budget.detail },
    ]);
  });

  $("#wf-run").addEventListener("click", async () => {
    if (!wfSpec) return;
    if (wfDirty) {
      return wfReport([{ level: "warn", text: "unsaved changes — the runner reads the file on disk, so save first" }]);
    }
    wfRun = null;
    watchRuns();
    const r = await fetch(`/api/workflows/${encodeURIComponent(wfSpec.name)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await r.json()) as { error?: string; detail?: string };
    wfReport([{ level: r.ok ? "ok" : "bad", text: body.error ?? body.detail ?? "started" }]);
  });
}
