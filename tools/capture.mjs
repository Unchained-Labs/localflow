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
 */
async function capture(name, note, focus) {
  const rect = focus
    ? await evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(focus)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const pad = 26;
          return [
            Math.max(0, Math.round(r.left - pad)),
            Math.max(0, Math.round(r.top - pad)),
            Math.round(r.width + pad * 2),
            Math.round(r.height + pad * 2),
          ];
        })()
      `)
    : null;
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = `${String(++shot).padStart(2, "0")}-${name}.png`;
  writeFileSync(join(out, file), Buffer.from(data, "base64"));
  manifest.push({ file, name, note, rect });
  console.log(`   ${file}${note ? `  — ${note}` : ""}${rect ? `  [${rect}]` : ""}`);
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
await evaluate(`
  (() => {
    const cards = [...document.querySelectorAll('.card')];
    const worst = cards.find(c => /\\$3\\d\\d|\\$1\\d\\d/.test(c.textContent)) ?? cards[0];
    worst.scrollIntoView({block:'nearest'});
    worst.focus();
    return worst.querySelector('h3').textContent;
  })()
`);
await wait(400);
await capture("card-focus", "one card: model, tokens, cost, cache share", ".lane-running .card");

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

await capture("waiting", "the waiting-on-you lane", ".lane-waiting");
await capture("board-end", "back to the board");

writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n   ${shot} frames -> ${out}`);
ws.close();
