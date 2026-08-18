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
}

interface Board {
  tasks: Task[];
  lanes: Record<Lane, number>;
  totals: { usage: Usage; costUsd: number | null; sessions: number; cacheHitRate: number | null };
  degraded: { id: string; reason: string }[];
  generatedAt: number;
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

function toast(msg: string, kind: "ok" | "err" | "info" = "info", ms = 6000): void {
  const t = el("div", { class: `toast ${kind}` }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

// ---- rendering --------------------------------------------------------------

function renderTotals(b: Board): void {
  const u = b.totals.usage;
  const cells: [string, string][] = [
    [String(b.totals.sessions), "sessions"],
    [tokens(u.output), "output tokens"],
    [money(b.totals.costUsd), "spent"],
    [b.totals.cacheHitRate === null ? "—" : `${Math.round(b.totals.cacheHitRate * 100)}%`, "from cache"],
  ];
  const host = $("#totals");
  host.replaceChildren(
    ...cells.map(([v, k]) => el("div", { class: "t" }, el("b", {}, v), el("span", {}, k))),
  );
}

function card(t: Task): HTMLElement {
  const c = el("article", { class: `card${t.source === "otter" ? " otter" : ""}`, tabIndex: 0 });
  c.dataset.id = t.id;
  c.draggable = true;

  c.append(el("h3", {}, t.title));

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
  if (t.toolErrors) bits.push(el("span", { class: "err" }, `${t.toolErrors} tool errors`));
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

function renderBoard(b: Board): void {
  const host = $("#board");
  const existing = new Map<string, HTMLElement>();
  host.querySelectorAll<HTMLElement>(".card").forEach((c) => existing.set(c.dataset.id!, c));

  host.replaceChildren(
    ...LANES.map(({ lane, label, blurb }) => {
      const inLane = b.tasks.filter((t) => t.lane === lane);
      const body = el("div", { class: "lane-body" });
      if (!inLane.length) body.append(el("p", { class: "empty" }, blurb));
      for (const t of inLane) {
        // Reuse the node when nothing on the card changed, so hover and focus
        // survive a poll.
        const prev = existing.get(t.id);
        const fresh = card(t);
        if (prev && prev.innerHTML === fresh.innerHTML) body.append(prev);
        else body.append(fresh);
      }
      return el(
        "section",
        { class: `lane lane-${lane}` },
        el(
          "div",
          { class: "lane-head" },
          el("i", { class: "dot" } as never),
          label,
          el("span", { class: "n" }, String(inLane.length)),
        ),
        body,
      );
    }),
  );

  const deg = $("#degraded");
  if (b.degraded.length) {
    deg.textContent = `${b.degraded.length} card(s) incomplete — ${b.degraded.map((d) => `${d.id.slice(0, 8)}: ${d.reason}`).join("; ")}`;
    deg.hidden = false;
  } else {
    deg.hidden = true;
  }
}

// ---- fan-out graph ----------------------------------------------------------

/** Draw the fan-outs a session actually performed. Geometry, not a library. */
function graphSvg(t: Task): SVGElement | null {
  if (!t.fanouts.length) return null;
  const NS = "http://www.w3.org/2000/svg";
  const rowH = 26;
  // Size the canvas to the widest fan-out. A fixed width left a session that
  // only ever called one agent at a time floating in three-quarters of nothing.
  const widest = Math.min(12, t.fanouts.reduce((a, f) => Math.max(a, f.width), 1));
  const w = Math.max(96, 54 + widest * 14);
  const h = 14 + t.fanouts.length * rowH + 8;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "graph");

  const mk = (tag: string, attrs: Record<string, string | number>) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  const spineX = 22;
  svg.append(mk("line", { x1: spineX, y1: 10, x2: spineX, y2: h - 8, stroke: "#232B35", "stroke-width": 1.2 }));
  const root = mk("circle", { cx: spineX, cy: 10, r: 3.2, fill: "#00D4AA" });
  svg.append(root);
  const rootLabel = mk("text", { x: spineX + 7, y: 12 });
  rootLabel.textContent = "session";
  svg.append(rootLabel);

  t.fanouts.forEach((f, i) => {
    const y = 10 + (i + 1) * rowH;
    svg.append(mk("line", { x1: spineX, y1: y - rowH, x2: spineX, y2: y, stroke: "#313B47", "stroke-width": 1.2 }));
    // Children spread to the right; the width of the spread is the width of the
    // fan-out, which is the whole point of drawing it.
    const n = Math.min(f.width, 12);
    const gap = Math.min(14, (w - spineX - 24) / Math.max(n, 1));
    for (let k = 0; k < n; k++) {
      const cx = spineX + 16 + k * gap;
      svg.append(mk("line", { x1: spineX, y1: y - 6, x2: cx, y2: y, stroke: "#313B47", "stroke-width": 0.9 }));
      const failed = k < f.failed;
      svg.append(mk("circle", { cx, cy: y, r: 2.6, fill: failed ? "#E5484D" : "#A8B3BF" }));
    }
    const label = mk("text", { x: spineX + 16 + n * gap + 4, y: y + 2, class: "small" });
    label.textContent = `${f.width}${f.width > n ? "+" : ""}${f.failed ? ` · ${f.failed} failed` : ""}`;
    svg.append(label);
  });
  return svg;
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

  const g = graphSvg(t);
  if (g) {
    body.append(
      el(
        "section",
        { class: "sec" },
        el("h4", {}, "the graph that ran"),
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

  // Notes come from the server, which owns the rules.
  try {
    const res = await fetch(`/api/task/${encodeURIComponent(t.id)}/graph`);
    if (res.ok) {
      const { notes } = (await res.json()) as { notes: { level: string; rule: string; message: string }[] };
      if (notes.length) {
        const sec = el("section", { class: "sec" }, el("h4", {}, "notes on this run"));
        for (const n of notes) {
          sec.append(el("div", { class: `note ${n.level}` }, el("b", {}, n.rule), n.message));
        }
        body.append(sec);
      }
    }
  } catch {
    /* notes are a nicety; the drawer is still useful without them */
  }

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
  wireDialog();
  wireDnD();
  connect();
}

void init();


/* ---------------------------------------------------------------------------
 * Metrics and the session archive.
 *
 * Both are pull-on-demand rather than pushed down the board's event stream: the
 * board updates every two seconds and neither of these changes at that rate, so
 * streaming them would be a lot of bytes to redraw a chart that looks the same.
 * ------------------------------------------------------------------------- */

type View = "board" | "metrics" | "sessions";

interface Slice { key: string; sessions: number; usage: Usage; costUsd: number | null; unpriced: number }
interface WaterTriple { low: number; mid: number; high: number }
interface WaterPayload {
  ok: boolean; detail: string; version?: string; factorsVersion?: string;
  total: WaterTriple; region: string; includeEmbodied: boolean;
  byModel: { model: string; ml: WaterTriple; tier?: string; assumed: boolean; assumptions: string[] }[];
  unknown: { model: string; reason: string }[];
  assumedModels: string[];
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

function bucketLabel(at: number, width: number): string {
  const d = new Date(at);
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return width < 24 * 3600_000
    ? `${day} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : day;
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
      age(Date.now() - r.updatedAt),
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

function setView(view: View): void {
  document.body.dataset.view = view;
  for (const btn of document.querySelectorAll<HTMLElement>(".view-btn")) {
    btn.setAttribute("aria-selected", String(btn.dataset.view === view));
  }
  if (view === "metrics") void renderMetrics();
  if (view === "sessions") void renderSessions(($("#sess-q") as HTMLInputElement).value);
}

function wireViews(): void {
  document.body.dataset.view = "board";
  for (const btn of document.querySelectorAll<HTMLElement>(".view-btn")) {
    btn.addEventListener("click", () => setView((btn.dataset.view ?? "board") as View));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  $("#sess-q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => void renderSessions((e.target as HTMLInputElement).value), 200);
  });
}
