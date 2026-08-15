/**
 * Handing preflight the one number it said it could not measure.
 *
 * preflight ships a `calibrate` command that replaces guessed token profiles
 * with medians from real runs, and its documentation is careful about the one
 * thing it deliberately does not do:
 *
 *   > It does not invent a cache hit rate. Usage rows do not report cache reads,
 *   > so there is nothing to derive one from.
 *
 * That is true of the rows it had. It is not true here: a Claude Code assistant
 * message reports `cache_read_input_tokens` and a `cache_creation` object split
 * by TTL. So the cache hit rate on this machine is a measurement — and it is the
 * assumption a cost model is most sensitive to, because cache reads are the
 * overwhelming majority of input tokens on a real session and bill at a tenth of
 * the input rate.
 *
 * **What is deliberately not written is the token counts.** A Claude Code
 * session is not a fan-out worker. preflight's `worker` profile means "one unit
 * of work: the unit's content in, a schema-constrained result out", and its
 * default is 8k input. An interactive session measures ~330k input per call on
 * this machine, because by call two hundred the context *is* the conversation.
 * Both numbers are correct and they are not the same quantity. Writing the
 * second into the first would produce a forty-fold error wearing the authority
 * of a measurement, which is precisely the failure preflight's own refusals
 * exist to prevent.
 *
 * So the default output carries the rate, and the token statistics are reported
 * for you to read rather than for a machine to consume. `--tokens` writes them
 * anyway, for the case where your workload really is shaped like your sessions.
 */
import { cacheWriteTotal } from "./types.js";
import type { Task, Usage } from "./types.js";

/** Below this, a "measurement" is a guess wearing a lab coat. */
export const MIN_SESSIONS = 3;

export interface Calibration {
  /** A `preflight.json` fragment, ready to write. */
  config: Record<string, unknown>;
  report: string;
  refusal?: string;
  measured: {
    sessions: number;
    modelCalls: number;
    cacheHitRate: number | null;
    medianInputPerCall: number;
    medianOutputPerCall: number;
    p10InputPerCall: number;
    p90InputPerCall: number;
    models: { model: string; sessions: number }[];
    costUsd: number | null;
  };
}

export interface CalibrateOptions {
  date?: string;
  /**
   * Also write the per-call token counts. Off by default: see the note above on
   * why a session's context size is not a worker's payload.
   */
  tokens?: boolean;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

/**
 * How many model calls a session made.
 *
 * Human turns are far fewer than API calls, and every tool result is followed by
 * another call, so tool calls are the usable floor. Where a session recorded
 * none, fall back to turns rather than dropping the session silently.
 */
function modelCalls(t: Task): number {
  const tools = Object.values(t.tools).reduce((a, b) => a + b, 0);
  return Math.max(tools, t.turns, 1);
}

function totalInput(u: Usage): number {
  return u.input + u.cacheRead + cacheWriteTotal(u);
}

export function calibrationFor(tasks: Task[], opts: CalibrateOptions = {}): Calibration {
  const usable = tasks.filter((t) => t.source === "claude" && t.usage.output > 0);

  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0 };
  const models = new Map<string, number>();
  let cost: number | null = null;
  const ins: number[] = [];
  const outs: number[] = [];
  let calls = 0;

  for (const t of usable) {
    totals.input += t.usage.input;
    totals.output += t.usage.output;
    totals.cacheRead += t.usage.cacheRead;
    totals.cacheWrite5m += t.usage.cacheWrite5m;
    totals.cacheWrite1h += t.usage.cacheWrite1h;
    totals.thinking += t.usage.thinking;
    if (t.model) models.set(t.model, (models.get(t.model) ?? 0) + 1);
    if (t.costUsd !== null) cost = (cost ?? 0) + t.costUsd;
    const n = modelCalls(t);
    calls += n;
    ins.push(Math.round(totalInput(t.usage) / n));
    outs.push(Math.round(t.usage.output / n));
  }

  ins.sort((a, b) => a - b);
  outs.sort((a, b) => a - b);

  const inputTotal = totalInput(totals);
  const hitRate = inputTotal > 0 ? totals.cacheRead / inputTotal : null;

  const measured: Calibration["measured"] = {
    sessions: usable.length,
    modelCalls: calls,
    cacheHitRate: hitRate,
    medianInputPerCall: pct(ins, 50),
    medianOutputPerCall: pct(outs, 50),
    p10InputPerCall: pct(ins, 10),
    p90InputPerCall: pct(ins, 90),
    models: [...models.entries()].map(([model, sessions]) => ({ model, sessions })).sort((a, b) => b.sessions - a.sessions),
    costUsd: cost,
  };

  const refusal =
    usable.length < MIN_SESSIONS
      ? `${usable.length} session(s) with recorded usage; ${MIN_SESSIONS} is the minimum. ` +
        "A profile from fewer carries the authority of a measurement and the accuracy of a guess."
      : undefined;

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  let config: Record<string, unknown> = {};

  if (!refusal && hitRate !== null) {
    // The rate is a property of how the workload caches, so it applies to every
    // node kind. The token counts are a property of *these* sessions, so they
    // only go in when asked for.
    const profiles: Record<string, Record<string, number>> = {};
    for (const kind of ["scope", "worker", "verifier", "synthesis"]) {
      profiles[kind] = { cacheHitRate: Number(hitRate.toFixed(4)) };
    }
    if (opts.tokens) {
      profiles.worker = {
        ...profiles.worker,
        input: measured.medianInputPerCall,
        output: measured.medianOutputPerCall,
      };
    }
    config = {
      profiles,
      $calibration: {
        source: "localflow (Claude Code transcripts on this machine)",
        calibratedOn: date,
        sessions: measured.sessions,
        modelCalls: calls,
        cacheHitRate: `measured across ${calls} model call(s): cache_read / all input tokens`,
        models: measured.models,
        tokenProfilesWritten: Boolean(opts.tokens),
        note: opts.tokens
          ? "Token counts came from interactive Claude Code sessions. A session's context is not a fan-out worker's payload — check the unit before trusting these."
          : "Only the cache hit rate was written. A Claude Code session's per-call input is its whole accumulated context, which is not the same quantity as a fan-out worker's payload, so the token counts are reported but not written. Pass --tokens to write them anyway.",
      },
    };
  }

  return { config, report: report(measured, Boolean(opts.tokens), refusal), refusal, measured };
}

function report(m: Calibration["measured"], wroteTokens: boolean, refusal?: string): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const out = ["", `  measured across ${m.sessions} session(s), ${n(m.modelCalls)} model call(s)`, ""];
  out.push(
    `  cacheHitRate       ${m.cacheHitRate === null ? "       —" : `${(m.cacheHitRate * 100).toFixed(1)}%`.padStart(8)}   measured, not assumed`,
  );
  out.push("");
  out.push("  reported, not written:");
  out.push(`    input per call   ${n(m.medianInputPerCall).padStart(11)}   p10–p90 ${n(m.p10InputPerCall)}–${n(m.p90InputPerCall)}`);
  out.push(`    output per call  ${n(m.medianOutputPerCall).padStart(11)}`);
  out.push("");
  if (!wroteTokens) {
    out.push(
      "  Those are per-call figures for interactive sessions, where the input is the",
      "  whole accumulated context — preflight's worker profile means one unit of work,",
      "  which is a different quantity by a couple of orders of magnitude. Only the",
      "  cache rate is written. Pass --tokens if your workload really is shaped like",
      "  your sessions.",
      "",
    );
  }
  if (m.models.length) {
    out.push("  models in the sample");
    for (const x of m.models) out.push(`    ${String(x.sessions).padStart(4)}  ${x.model}`);
    out.push("");
  }
  if (m.cacheHitRate !== null && m.cacheHitRate > 0.5) {
    out.push(
      `  ${Math.round(m.cacheHitRate * 100)}% of input tokens are cache reads, billed at a tenth of the input rate.`,
      "  A cost model assuming no caching over-reports this workload several times over.",
      "",
    );
  }
  if (refusal) out.push(`  refusing to write: ${refusal}`, "");
  return out.join("\n");
}
