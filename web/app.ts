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
  wireDialog();
  wireDnD();
  connect();
}

void init();
