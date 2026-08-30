/** The board, as a terminal reads it. */
import { identityFor } from "./agents/identity.js";
import { cacheWriteTotal } from "./types.js";
import type { BoardSummary, Lane, Task } from "./types.js";

const colour = process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY);
const c = (k: string) => (s: string) => (colour ? `\x1b[${k}m${s}\x1b[0m` : s);
const bold = c("1"), dim = c("2"), grey = c("90"), green = c("32"), yellow = c("33"), cyan = c("36"), red = c("31");

const LANES: { lane: Lane; label: string; paint: (s: string) => string }[] = [
  { lane: "running", label: "running", paint: green },
  { lane: "queued", label: "queued", paint: cyan },
  { lane: "waiting", label: "waiting on you", paint: yellow },
  { lane: "ended", label: "ended", paint: grey },
];

export function tokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function money(usd: number | null): string {
  if (usd === null) return "—";
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

export function age(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function card(t: Task, many: boolean): string[] {
  const out: string[] = [];
  const title = t.title.length > 62 ? `${t.title.slice(0, 61)}…` : t.title;
  // No error flag beside the title. A tool_result with is_error is routine — a
  // grep that matched nothing, a command that exited 1 — so flagging it made
  // every card on a healthy board look broken. The count goes in the detail line
  // where it is information rather than an alarm.
  // The machine goes in front of the title, not into the detail line: on a
  // fleet board "which box is this on" is the first thing you need in order to
  // read anything else on the card, and a local session stays unlabelled so the
  // label keeps meaning something.
  const where = t.device ? `${cyan(`@${t.device}`)} ` : "";
  // Only once there is more than one kind of session here. A column of `cc`
  // down a Claude-only board is a column of pixels spent on something its
  // reader already knew.
  const who = many ? `${grey(`[${identityFor(t.source).glyph}]`)} ` : "";
  out.push(`    ${who}${where}${bold(title)}`);

  const bits = [
    grey(t.name),
    t.model ? grey(t.model.replace(/^claude-/, "")) : "",
    t.usage.output ? grey(`${tokens(t.usage.output)} out`) : "",
    t.costUsd !== null ? grey(money(t.costUsd)) : grey("cost unknown"),
    t.cacheHitRate !== null ? grey(`${Math.round(t.cacheHitRate * 100)}% cached`) : "",
    grey(age(t.updatedAt)),
    // A floor is not a total, and a card that pulled only the tail of its
    // transcript must not show its cost as if it were the whole bill.
    t.partial ? yellow("partial — cost is a floor") : "",
    t.staleSince ? yellow(`last seen ${age(t.staleSince)} ago — device unreachable`) : "",
  ].filter(Boolean);
  out.push(`      ${bits.join(grey(" · "))}`);

  const detail: string[] = [];
  if (t.cwd) detail.push(t.cwd.replace(process.env.HOME ?? "~", "~"));
  if (t.branch) detail.push(t.branch);
  if (t.lastToolName) detail.push(`last: ${t.lastToolName}`);
  if (t.fanouts.length) {
    const widest = t.fanouts.reduce((a, f) => Math.max(a, f.width), 0);
    const children = t.fanouts.reduce((a, f) => a + f.width, 0);
    // Width 1 is a subagent call, not a fan-out. Saying "widest 1" invited the
    // reader to look for parallelism that never happened.
    detail.push(
      widest > 1
        ? `${children} agent(s), widest fan-out ${widest}`
        : `${children} agent call(s), none parallel`,
    );
  }
  if (t.toolErrors) detail.push(red(`${t.toolErrors} tool error(s)`));
  if (t.queue.length) detail.push(yellow(`${t.queue.length} queued prompt(s)`));
  if (detail.length) out.push(`      ${dim(detail.join(" · "))}`);
  return out;
}

export function renderBoard(
  b: BoardSummary,
  opts: { pricingVerified?: string; asOf?: string } = {},
): string {
  const out: string[] = [""];
  const u = b.totals.usage;

  out.push(
    `  ${bold("localflow")}  ${grey(`${b.totals.sessions} session(s) · ${tokens(u.output)} out · ${tokens(u.cacheRead)} cached in · ${money(b.totals.costUsd)}`)}`,
  );
  if (b.totals.cacheHitRate !== null) {
    out.push(
      `             ${grey(`${Math.round(b.totals.cacheHitRate * 100)}% of input tokens came from cache`)}`,
    );
  }
  out.push("");

  if (!b.tasks.length) {
    out.push(`  ${yellow("!")} ${bold("no sessions found")}`);
    out.push("");
    out.push(`     ${dim("The registry answered, and it listed nothing. That means no Claude Code")}`);
    out.push(`     ${dim("session is running here — not that localflow failed to look.")}`);
    out.push("");
    return out.join("\n");
  }

  const many = new Set(b.tasks.map((t) => t.source)).size > 1;
  for (const { lane, label, paint } of LANES) {
    const inLane = b.tasks.filter((t) => t.lane === lane);
    if (!inLane.length) continue;
    out.push(`  ${paint(label)} ${grey(`(${inLane.length})`)}`);
    out.push("");
    for (const t of inLane) {
      out.push(...card(t, many));
      out.push("");
    }
  }

  // The key, once, under the lanes. A monogram nobody can expand is a worse
  // label than the id it replaced.
  if (many) {
    const seen = [...new Set(b.tasks.map((t) => t.source))].sort();
    out.push(
      grey(`  ${seen.map((id) => `[${identityFor(id).glyph}] ${identityFor(id).label}`).join("   ")}`),
    );
    out.push("");
  }

  if (b.degraded.length) {
    out.push(`  ${yellow("!")} ${dim(`${b.degraded.length} card(s) are showing less than the full picture:`)}`);
    for (const d of b.degraded.slice(0, 5)) {
      // A whole-device note is about a machine, not a session, so it is labelled
      // with the machine. Truncating "device:studio" to eight characters gave
      // "device:s", which named nothing.
      const label = d.id.startsWith("device:") ? `@${d.id.slice("device:".length)}` : d.id.slice(0, 8);
      out.push(`     ${grey(`${label}  ${d.reason}`)}`);
    }
    out.push("");
  }

  const written = cacheWriteTotal(u);
  out.push(
    grey(
      `  ${tokens(u.input)} fresh in · ${tokens(written)} cache writes · ${tokens(u.thinking)} thinking` +
        (opts.pricingVerified ? ` · prices verified ${opts.pricingVerified}` : ""),
    ),
  );
  out.push(grey("  cost is derived from measured tokens, not reported by the provider"));
  out.push("");
  return out.join("\n");
}
