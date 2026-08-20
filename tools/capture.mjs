#!/usr/bin/env node
/**
 * Capture the dashboard, state by state, for the demo reel.
 *
 * A terminal recording was the wrong medium for this product: localflow's whole
 * point is the board, and a screencast of `localflow board` shows everything
 * except the thing being sold. So this drives a real Chrome against a real
 * server over the DevTools Protocol, performs the interactions a person would,
 * and saves a frame after each one.
 *
 * The machine it films is written by `tools/fixture.mjs` and pointed at through
 * the environment, so the server, the parser and the UI are all the shipping
 * code — only the files under them are synthetic. A beat whose feature is not
 * present on the machine being filmed skips itself rather than photographing an
 * empty panel, and says so; `tools/mkdemo.py` then drops the caption that would
 * have narrated it.
 *
 * No Puppeteer. CDP is a WebSocket that takes JSON, Node 22 has a WebSocket
 * client, and the whole conversation is six message types.
 *
 * Usage: node tools/capture.mjs <out-dir> [--port 7317] [--cdp 9222]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: capture.mjs <out-dir> [--port N] [--cdp N]");
  process.exit(2);
}
const flag = (n, d) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? d : process.argv[i + 1];
};
const PORT = flag("--port", "7317");
const CDP = flag("--cdp", "9222");
mkdirSync(out, { recursive: true });

// ---- CDP plumbing ------------------------------------------------------------

const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target — is Chrome running with --remote-debugging-port?");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? {})})`));
  else p.resolve(msg.result);
});

function send(method, params = {}) {
  const n = ++id;
  return new Promise((resolve, reject) => {
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => {
      if (pending.delete(n)) reject(new Error(`${method} timed out`));
    }, 30_000);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run an expression in the page and return its value. Throws on a page-side throw. */
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.text}`);
  return r.result?.value;
}

let shot = 0;
const manifest = [];

/**
 * Capture a frame, and with it the on-screen rectangle of anything worth zooming
 * into later. Measuring the crop in the browser beats eyeballing it off the
 * PNG: the compositor then frames the dialog exactly, and it keeps working when
 * the layout moves.
 *
 * `focus` may name several selectors, in which case the rectangle is their
 * union — the metrics grid puts two panels side by side and a beat about both
 * of them wants both of them in frame.
 */
async function capture(name, note, focus) {
  const selectors = focus ? (Array.isArray(focus) ? focus : [focus]) : null;
  const rect = selectors
    ? await evaluate(`
        (() => {
          const els = ${JSON.stringify(selectors)}
            .map((s) => document.querySelector(s))
            .filter(Boolean);
          if (!els.length) return null;
          const rs = els.map((e) => e.getBoundingClientRect());
          const pad = 26;
          // Clamped to the viewport: the screenshot is exactly this big, and a
          // rectangle that runs past its edge is composited as a black band
          // down the side of the frame.
          const left = Math.max(0, Math.min(...rs.map((r) => r.left)) - pad);
          const top = Math.max(0, Math.min(...rs.map((r) => r.top)) - pad);
          const right = Math.min(window.innerWidth, Math.max(...rs.map((r) => r.right)) + pad);
          const bottom = Math.min(window.innerHeight, Math.max(...rs.map((r) => r.bottom)) + pad);
          return [Math.round(left), Math.round(top), Math.round(right - left), Math.round(bottom - top)];
        })()
      `)
    : null;
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = `${String(++shot).padStart(2, "0")}-${name}.png`;
  writeFileSync(join(out, file), Buffer.from(data, "base64"));
  manifest.push({ file, name, note, rect });
  console.log(`   ${file}${note ? `  — ${note}` : ""}${rect ? `  [${rect}]` : ""}`);
}

/**
 * Bring an element to the middle of the viewport and let the page settle.
 *
 * The metrics tab is four screens tall, and a crop is measured against the
 * viewport — so a panel has to actually be on screen before its rectangle means
 * anything. Returns false when the element is not there, which is how a beat
 * for a feature this machine is not using (no devices, no soif) skips itself
 * instead of filming an empty box.
 */
async function reveal(selector, block = "center") {
  const ok = await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: ${JSON.stringify(block)} });
      return true;
    })()
  `);
  if (ok) await wait(500);
  return ok;
}

/**
 * Name the metrics panels so the beats can address them.
 *
 * The panels are built from a list and carry no ids, and matching on heading
 * text at capture time would put an English string inside every selector below.
 * One pass here turns "Five-hour block" into `[data-beat="five-hour-block"]`,
 * which is stable as long as the heading is — and if a heading changes, the
 * beat that wanted it fails loudly rather than cropping whatever is nearby.
 */
async function tagPanels() {
  return await evaluate(`
    (() => {
      const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const named = [];
      for (const p of document.querySelectorAll(".panel")) {
        const h = p.querySelector("h3");
        if (!h) continue;
        p.dataset.beat = slug(h.textContent ?? "");
        named.push(p.dataset.beat);
      }
      return named;
    })()
  `);
}

// ---- the tour ----------------------------------------------------------------

await send("Page.enable");
await send("Runtime.enable");

// `?snapshot` renders once and holds no EventSource open, which is what makes a
// headless page settle at all.
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?snapshot` });
await wait(2500);
await evaluate(`document.querySelectorAll('.card').length`);

await capture("board", "the board: four lanes of live sessions");
await capture("totals", "the totals bar", ".totals");

// Focus the most expensive card, so the ring shows and the eye goes there.
// Tagged rather than cropped by lane: `.lane-running .card` is whichever card
// sorted first, which is not the one the ring is on.
const worst = await evaluate(`
  (() => {
    const money = (c) => Number((c.textContent.match(/\\$([\\d.,]+)/) ?? ['', '0'])[1].replace(/,/g, ''));
    const cards = [...document.querySelectorAll('.card')].sort((a, b) => money(b) - money(a));
    const worst = cards[0];
    worst.dataset.beat = 'card-focus';
    worst.scrollIntoView({block:'nearest'});
    worst.focus();
    return worst.querySelector('h3').textContent;
  })()
`);
console.log(`   (focused: ${worst})`);
await wait(400);
await capture("card-focus", "one card: model, tokens, cost, cache share", '[data-beat="card-focus"]');

// A card from a tool that is not Claude Code, and — right beside it — one whose
// model nobody here has a rate for. Both come from sources.json, and the second
// is the beat: it says "cost unknown" rather than $0.00.
const declared = await evaluate(`
  (() => {
    const cards = [...document.querySelectorAll('.card')];
    const fromFile = (c) => /\\.jsonl/.test(c?.querySelector('.meta')?.textContent ?? '');
    const unpriced = cards.find(c => /cost unknown/i.test(c.textContent));
    // Its neighbour, so the two are in one frame: a declared source that is
    // priced sitting next to one that is not.
    const other = [unpriced?.previousElementSibling, unpriced?.nextElementSibling].find(fromFile)
      ?? cards.find(c => c !== unpriced && fromFile(c));
    if (unpriced) unpriced.dataset.beat = 'unpriced';
    if (other) other.dataset.beat = 'declared';
    (unpriced ?? other)?.scrollIntoView({block:'center'});
    return [other?.querySelector('h3').textContent, unpriced?.querySelector('h3').textContent];
  })()
`);
console.log(`   (declared sources: ${declared.filter(Boolean).join(" / ") || "none"})`);
if (declared.some(Boolean)) {
  await wait(400);
  await capture("sources", "other tools' sessions, and one nobody can price", [
    '[data-beat="declared"]',
    '[data-beat="unpriced"]',
  ]);
}

// The waiting lane, filmed here rather than at the end of the tour: the refused
// drag below leaves its "you cannot drop that here" marker on the lane it was
// refused by, and a beat about the lane should not be showing the state some
// later beat put it in.
await capture("waiting", "the waiting-on-you lane", ".lane-waiting");

// Open the detail drawer on a session that actually fanned out.
//
// Matching /agent/ anywhere in the card text picked a session whose *title*
// happened to contain the word, and it had no fan-out at all — so the beat that
// exists to show the graph showed an empty drawer. Match the sub-line, which
// only says "N agent calls" when there were some.
const opened = await evaluate(`
  (() => {
    const cards = [...document.querySelectorAll('.card')];
    const withGraph =
      cards.find(c => /\\d+ agents?(,| )/.test(c.querySelector('.sub')?.textContent ?? '')) ?? cards[0];
    withGraph.click();
    return withGraph.querySelector('h3').textContent;
  })()
`);
console.log(`   (opened drawer on: ${opened})`);
await wait(1400);
await capture("drawer", "detail: what it spent, what it called", ".drawer");

// Scroll the drawer to the observed fan-out graph.
await evaluate(`
  (() => {
    const b = document.querySelector('.drawer-body');
    const g = [...b.querySelectorAll('.sec')].find(s => /graph that ran/i.test(s.textContent));
    if (g) g.scrollIntoView({block:'start'});
    return !!g;
  })()
`);
await wait(700);
await capture("graph", "the fan-out the session actually performed", ".drawer");

// Notes, if this session earned any.
await evaluate(`
  (() => {
    const b = document.querySelector('.drawer-body');
    b.scrollTop = b.scrollHeight;
    return b.querySelectorAll('.note').length;
  })()
`);
await wait(600);
await capture("actions", "actions, and what it noticed about this run", ".drawer");

// Reroute: the model picker.
const rerouted = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.drawer-body .btn')].find(x => /Reroute/i.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  })()
`);
if (rerouted) {
  await wait(700);
  await evaluate(`document.querySelector('#f-model').value = 'sonnet'`);
  await evaluate(`
    document.querySelector('#f-prompt').value =
      'Same conversation, cheaper model — finish the migration and stop.'
  `);
  await wait(300);
  await capture("reroute", "reroute: same conversation, different model", "#dlg");
  await evaluate(`document.querySelector('#dlg').close()`);
  await wait(400);
}

// A refused drag: the board says why instead of snapping the card back.
await evaluate(`document.querySelector('#d-close').click()`);
await wait(500);
await evaluate(`
  (() => {
    const card = [...document.querySelectorAll('.lane-waiting .card, .card')][0];
    const lane = document.querySelector('.lane-waiting') ?? document.querySelector('.lane');
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    lane.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    lane.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return document.querySelectorAll('.toast').length;
  })()
`);
await wait(600);
await capture("refuse", "a move with no real action behind it is refused, with a reason", ".toasts");

// New task.
await evaluate(`
  (() => {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const b = document.querySelector('#new-task');
    if (b && !b.hidden) { b.click(); return true; }
    return false;
  })()
`);
await wait(700);
await evaluate(`
  (() => {
    const p = document.querySelector('#f-prompt');
    if (p) p.value = 'Audit the billing routes and open a PR with the fixes.';
    const m = document.querySelector('#f-model'); if (m) m.value = 'opus';
    const e = document.querySelector('#f-effort'); if (e) e.value = 'high';
  })()
`);
await wait(300);
await capture("spawn", "start a background agent from the board", "#dlg");
await evaluate(`document.querySelector('#dlg')?.close()`);
await wait(400);

// ---- metrics -----------------------------------------------------------------
//
// Everything below this line was added when the board grew answers to questions
// the first reel could not ask: what it is costing per hour, which five-hour
// block that lands in, what it cost in freshwater, and which machine it ran on.
// A tour that stops at the board now stops halfway through the product.

await evaluate(`document.querySelector('[data-view="metrics"]').click()`);
// The metrics tab fetches /api/metrics, and water inside it shells out to soif
// once per model. Two and a half seconds is the pause a person sees too.
await wait(2600);
await evaluate(`window.scrollTo(0, 0)`);
await wait(300);

const panels = await tagPanels();
console.log(`   (panels: ${panels.join(", ")})`);

await capture("metrics", "the totals every panel below is a cut of", "#metrics > .stat-row");

if (await reveal('[data-beat="burn-rate"]')) {
  await capture("burn", "burn rate, and what each rate was extrapolated from", '[data-beat="burn-rate"]');
}
if (await reveal('[data-beat="five-hour-block"]')) {
  await capture("block", "the five-hour block, and where this rate lands in it", '[data-beat="five-hour-block"]');
}
if (await reveal('[data-beat="spend-over-time"]')) {
  await capture("spend", "spend over time, hatched where nobody could price the work", [
    '[data-beat="spend-over-time"]',
    '[data-beat="by-model"]',
  ]);
}
if (await reveal('[data-beat="by-tool"]')) {
  await capture("bytool", "which agent produced the work, and in which project", [
    '[data-beat="by-tool"]',
    '[data-beat="by-project"]',
  ]);
}
if (await reveal('[data-beat="observed-fan-out"]')) {
  await capture("fanout", "how wide the parallelism actually got, across every session", [
    '[data-beat="observed-fan-out"]',
    '[data-beat="tools-used"]',
  ]);
}
if (await reveal('[data-beat="water"]', "start")) {
  await capture("water", "what the answers cost in freshwater, via soif", '[data-beat="water"]');
}

// ---- the archive, and the machines -------------------------------------------

await evaluate(`window.scrollTo(0, 0); document.querySelector('[data-view="sessions"]').click()`);
await wait(1600);
await capture("archive", "every session on disk, not just the ones the board keeps", "#sessions .panel");

if (await reveal("#devices", "start")) {
  await capture("devices", "machines this board can start work on, over ssh, inside tmux", "#devices .panel");
}

await evaluate(`window.scrollTo(0, 0); document.querySelector('[data-view="board"]').click()`);
await wait(900);
await capture("board-end", "back to the board");

writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n   ${shot} frames -> ${out}`);
ws.close();
