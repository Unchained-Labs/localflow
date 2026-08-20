/**
 * The rest of the family, run against the graph that actually ran.
 *
 * localflow can reconstruct the graph a session performed. graphlint can say
 * what is wrong with a graph, and preflight can price one. Those are three
 * tools that already fit together, and until now the only thing joining them
 * was a line in a README telling you to pipe one into the other yourself.
 *
 * This is that pipe, run from inside the board — and it is a pipe rather than a
 * port. **No rule from either tool is reimplemented here.** The same argument
 * as `water.ts`: a second implementation of somebody else's rule set is wrong
 * within a release and wrong silently, and the family's whole claim is that its
 * tools do not disagree with each other. So the spec goes out on stdin, the
 * JSON comes back, and localflow renders whatever it is told.
 *
 * Three rules, all inherited from how this repo already treats soif:
 *
 *   * **Absent is absent, never clean.** A missing `graphlint` produces "not
 *     installed", not "no findings". A linter that reports zero problems
 *     because it never ran is the false clean this whole family exists to
 *     avoid, and it is the single easiest one to ship by accident.
 *   * **A non-zero exit is an answer.** `graphlint check` exits 1 when a rule
 *     fires; `preflight estimate` exits 1 over `--max-usd`. Treating exit codes
 *     as failure would discard exactly the runs that had something to say. Only
 *     exit 2 — bad usage — and a crash are failures.
 *   * **What the transcript cannot record is said out loud.** An observed spec
 *     carries no output schemas, because a transcript does not record whether a
 *     subagent was given one. graphlint quite correctly reports that as
 *     `missing-schema` on every node. That finding is about localflow's input,
 *     not about the session, and it travels with a note saying so rather than
 *     being filtered away behind the reader's back.
 */
import { spawn } from "node:child_process";

import type { ObservedSpec } from "./graph.js";

/** Findings that mean "localflow could not see this", not "the session did this". */
const OBSERVED_BLIND_SPOTS: Record<string, string> = {
  "missing-schema":
    "a transcript does not record whether a subagent was given an output schema, so an observed graph never has one to show",
};

export interface FamilyOptions {
  /** Override the binary. For tests and non-standard installs. */
  bin?: string;
  timeoutMs?: number;
}

export interface Probe {
  ok: boolean;
  version?: string;
  detail: string;
}

/** One finding, as graphlint reports it. Passed through, not re-derived. */
export interface LintFinding {
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  /** Set when the finding is about what localflow could not observe. */
  aboutTheInput?: string;
}

export interface LintReport {
  ok: boolean;
  /** Why there is no report. Empty when there is one. */
  detail: string;
  version?: string;
  findings: LintFinding[];
  summary: { errors: number; warnings: number; infos: number };
}

export interface EstimateReport {
  ok: boolean;
  detail: string;
  version?: string;
  /** preflight's own triple. Never collapsed to the midpoint. */
  agents?: { low: number; expected: number; high: number };
  usd?: { low: number; expected: number; high: number };
  tokens?: { input: number; output: number };
  /** Nodes whose width preflight had to assume rather than read. */
  assumedWidths: string[];
}

function bin(env: string, fallback: string, opts: FamilyOptions): string {
  return opts.bin ?? process.env[env] ?? fallback;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  spawnError?: NodeJS.ErrnoException;
}

/**
 * Run a binary with `input` on stdin and collect what it says.
 *
 * `execFile` cannot write stdin without a temp file, and a temp file for a
 * document we already hold in memory is a file to leak. The exit code is
 * returned rather than thrown on, because for both of these tools it is data.
 */
function run(cmd: string, args: string[], input: string, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: e as NodeJS.ErrnoException });
      return;
    }

    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: Ran) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (e) => finish({ code: null, stdout, stderr, spawnError: e as NodeJS.ErrnoException }));
    child.on("close", (code) => finish({ code, stdout, stderr }));

    // A tool that exits before reading its input closes the pipe under us, and
    // the resulting EPIPE is not an error worth reporting: whatever it wrote is
    // still the answer.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Is it installed? Absence is an answer, not a failure. */
async function probe(cmd: string, name: string, missing: string, timeoutMs: number): Promise<Probe> {
  const r = await run(cmd, ["--version"], "", timeoutMs);
  if (r.spawnError?.code === "ENOENT") {
    // Says what is not happening, not just what is not installed. "graphlint is
    // absent" invites the reader to fill in "so the graph is fine".
    return { ok: false, detail: `${name} is not installed, so ${missing}. Install it with \`npm i -g ${name}\`.` };
  }
  if (r.spawnError) return { ok: false, detail: `could not run ${name}: ${r.spawnError.message}` };
  if (r.code !== 0) return { ok: false, detail: `${name} --version exited ${r.code}` };
  return { ok: true, version: r.stdout.trim(), detail: "" };
}

export function graphlintBin(opts: FamilyOptions = {}): string {
  return bin("LOCALFLOW_GRAPHLINT_BIN", "graphlint", opts);
}

export function preflightBin(opts: FamilyOptions = {}): string {
  return bin("LOCALFLOW_PREFLIGHT_BIN", "preflight", opts);
}

export function probeGraphlint(opts: FamilyOptions = {}): Promise<Probe> {
  return probe(graphlintBin(opts), "graphlint", "nothing has linted this graph", opts.timeoutMs ?? 5_000);
}

export function probePreflight(opts: FamilyOptions = {}): Promise<Probe> {
  return probe(preflightBin(opts), "preflight", "nothing has priced this graph", opts.timeoutMs ?? 5_000);
}

export function decorrelateBin(opts: FamilyOptions = {}): string {
  return bin("LOCALFLOW_DECORRELATE_BIN", "decorrelate", opts);
}

export function probeDecorrelate(opts: FamilyOptions = {}): Promise<Probe> {
  return probe(
    decorrelateBin(opts),
    "decorrelate",
    "there is no lens plan to offer",
    opts.timeoutMs ?? 5_000,
  );
}

interface RawLint {
  summary?: { errors?: number; warnings?: number; infos?: number };
  results?: { findings?: { rule?: unknown; severity?: unknown; message?: unknown }[] }[];
}

/**
 * Lint the graph that ran.
 *
 * `graphlint check -` takes one spec on stdin, which is exactly the shape
 * `observedSpec` produces — the README's own `localflow graph <id> | graphlint
 * check -`, with the pipe on this side of the process boundary.
 */
export async function lintObserved(spec: ObservedSpec, opts: FamilyOptions = {}): Promise<LintReport> {
  const empty: LintReport = { ok: false, detail: "", findings: [], summary: { errors: 0, warnings: 0, infos: 0 } };
  const p = await probeGraphlint(opts);
  if (!p.ok) return { ...empty, detail: p.detail };

  const r = await run(
    graphlintBin(opts),
    ["check", "-", "--format", "json"],
    `${JSON.stringify(spec)}\n`,
    opts.timeoutMs ?? 20_000,
  );
  // 0 is clean, 1 is "rules fired". Both ran. 2 is bad usage and anything else
  // is a crash — those are the only real failures.
  if (r.code !== 0 && r.code !== 1) {
    const why = (r.stderr || r.stdout || "no output").trim().split("\n")[0];
    return { ...empty, version: p.version, detail: `graphlint exited ${r.code}: ${why}` };
  }

  let raw: RawLint;
  try {
    raw = JSON.parse(r.stdout) as RawLint;
  } catch (e) {
    return { ...empty, version: p.version, detail: `graphlint did not return JSON: ${(e as Error).message}` };
  }

  const findings: LintFinding[] = [];
  for (const result of raw.results ?? []) {
    for (const f of result.findings ?? []) {
      const rule = typeof f.rule === "string" ? f.rule : "unknown";
      findings.push({
        rule,
        severity: (f.severity === "error" || f.severity === "warning" ? f.severity : "info"),
        message: typeof f.message === "string" ? f.message : "",
        aboutTheInput: OBSERVED_BLIND_SPOTS[rule],
      });
    }
  }

  return {
    ok: true,
    detail: "",
    version: p.version,
    findings,
    summary: {
      errors: raw.summary?.errors ?? 0,
      warnings: raw.summary?.warnings ?? 0,
      infos: raw.summary?.infos ?? 0,
    },
  };
}

interface RawEstimate {
  after?: {
    agents?: { low?: number; expected?: number; high?: number };
    usd?: { low?: number; expected?: number; high?: number };
    tokens?: { input?: number; output?: number };
    nodes?: { id?: unknown; widthAssumed?: unknown }[];
  };
}

const triple = (t: { low?: number; expected?: number; high?: number } | undefined) =>
  t && typeof t.low === "number" && typeof t.expected === "number" && typeof t.high === "number"
    ? { low: t.low, expected: t.expected, high: t.high }
    : undefined;

/**
 * Price the same graph the way preflight would have priced it beforehand.
 *
 * The interesting number is not the estimate; it is the *gap*. localflow knows
 * what the session actually cost, measured from its own token counts, and
 * preflight knows what its profiles would have predicted. When those disagree
 * by an order of magnitude the profile is wrong for this kind of work, and
 * `localflow calibrate` is the thing that fixes it. Neither number is worth
 * much alone and together they are a to-do list.
 */
export async function estimateObserved(spec: ObservedSpec, opts: FamilyOptions = {}): Promise<EstimateReport> {
  const empty: EstimateReport = { ok: false, detail: "", assumedWidths: [] };
  const p = await probePreflight(opts);
  if (!p.ok) return { ...empty, detail: p.detail };

  const r = await run(
    preflightBin(opts),
    ["estimate", "-", "--format", "json"],
    `${JSON.stringify(spec)}\n`,
    opts.timeoutMs ?? 20_000,
  );
  if (r.code !== 0 && r.code !== 1) {
    const why = (r.stderr || r.stdout || "no output").trim().split("\n")[0];
    return { ...empty, version: p.version, detail: `preflight exited ${r.code}: ${why}` };
  }

  let raw: RawEstimate;
  try {
    raw = JSON.parse(r.stdout) as RawEstimate;
  } catch (e) {
    return { ...empty, version: p.version, detail: `preflight did not return JSON: ${(e as Error).message}` };
  }

  const after = raw.after;
  if (!after) return { ...empty, version: p.version, detail: "preflight returned no estimate" };

  return {
    ok: true,
    detail: "",
    version: p.version,
    agents: triple(after.agents),
    usd: triple(after.usd),
    tokens:
      typeof after.tokens?.input === "number" && typeof after.tokens?.output === "number"
        ? { input: after.tokens.input, output: after.tokens.output }
        : undefined,
    // Named rather than counted: "preflight assumed the width of these three"
    // is actionable, "3 widths assumed" is trivia.
    assumedWidths: (after.nodes ?? [])
      .filter((n) => n.widthAssumed === true && typeof n.id === "string")
      .map((n) => n.id as string),
  };
}

/**
 * What the estimate and the measurement say about each other.
 *
 * Returned as a ratio and a sentence rather than a verdict: preflight's default
 * profiles describe *one unit of work*, and an interactive session is hundreds
 * of turns whose context is the conversation, so a large gap is the expected
 * result and not a bug in either tool. It is still worth saying, because the
 * fix — measuring the profile from real sessions — is one command away.
 */
export function estimateGap(
  actualUsd: number | null,
  estimate: EstimateReport,
): { ratio: number; note: string } | null {
  const expected = estimate.usd?.expected;
  if (!estimate.ok || expected === undefined || expected <= 0) return null;
  if (actualUsd === null) return null;

  const ratio = actualUsd / expected;
  if (ratio >= 0.5 && ratio <= 2) {
    return { ratio, note: "preflight's profiles are close to what this session actually did." };
  }
  const times = ratio > 1 ? `${ratio.toFixed(1)}x more` : `${(1 / ratio).toFixed(1)}x less`;
  return {
    ratio,
    note:
      `This session cost ${times} than preflight's profiles predict for its shape. ` +
      "That is usually the profile rather than the run — preflight's `worker` means one unit of work and " +
      "defaults to 8k input, where an interactive session's context is the whole conversation. " +
      "`localflow calibrate` writes a profile measured from the sessions on this board.",
  };
}


/* ---------------------------------------------------------------------------
 * decorrelate, and the one thing localflow must not ask it
 *
 * decorrelate's main verb is `report`, which measures how correlated a panel of
 * verifiers actually was — from their *verdicts*. localflow does not have
 * verdicts. A transcript records that five agents were issued and which of them
 * returned a tool error; it does not record what any of them concluded, and an
 * error is not a "no". Feeding `report` a column of made-up verdicts would
 * produce a real κ over invented data, which is worse than no number at all,
 * so localflow does not do it and says why.
 *
 * What it can honestly offer is the other verb. `decorrelate lenses <domain>`
 * plans a set of deliberately different questions, and a plan needs no run data
 * — so when a fan-out is caught asking one question three times, the fix is one
 * command away and localflow can show it.
 * ------------------------------------------------------------------------- */

/** Why `decorrelate report` is not wired up, in one sentence, for the UI. */
export const NO_VERDICTS =
  "localflow cannot run `decorrelate report` on this: a transcript records which agents ran and which " +
  "errored, never what any of them concluded — and a κ computed over invented verdicts is worse than no κ.";

export interface Lens {
  key: string;
  question: string;
  catches: string;
  model?: string;
  oracleHint?: string;
}

export interface LensPlan {
  ok: boolean;
  detail: string;
  version?: string;
  domain: string;
  lenses: Lens[];
}

/**
 * A diverse-lens plan, for a fan-out that asked one question N times.
 *
 * Defaults to `generic` on purpose. decorrelate has domain-specific plans —
 * security, correctness, performance — and choosing between them from a
 * transcript would be localflow guessing at what a session was for. `generic`
 * is the plan that is true whatever the work was; the domain is the caller's to
 * pick, and decorrelate names the ones it knows if you ask it for one it does not.
 */
export async function lensPlan(domain = "generic", opts: FamilyOptions = {}): Promise<LensPlan> {
  const empty: LensPlan = { ok: false, detail: "", domain, lenses: [] };
  const p = await probeDecorrelate(opts);
  if (!p.ok) return { ...empty, detail: p.detail };

  const r = await run(
    decorrelateBin(opts),
    ["lenses", domain, "--format", "json"],
    "",
    opts.timeoutMs ?? 20_000,
  );
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout || "no output").trim().split("\n")[0] ?? "";
    return { ...empty, version: p.version, detail: why };
  }

  let raw: { domain?: unknown; lenses?: unknown[] };
  try {
    raw = JSON.parse(r.stdout) as { domain?: unknown; lenses?: unknown[] };
  } catch (e) {
    return { ...empty, version: p.version, detail: `decorrelate did not return JSON: ${(e as Error).message}` };
  }

  const lenses: Lens[] = [];
  for (const l of raw.lenses ?? []) {
    const o = l as Record<string, unknown>;
    if (typeof o?.key !== "string" || typeof o?.question !== "string") continue;
    lenses.push({
      key: o.key,
      question: o.question,
      catches: typeof o.catches === "string" ? o.catches : "",
      model: typeof o.model === "string" ? o.model : undefined,
      oracleHint: typeof o.oracleHint === "string" ? o.oracleHint : undefined,
    });
  }

  return {
    ok: true,
    detail: "",
    version: p.version,
    domain: typeof raw.domain === "string" ? raw.domain : domain,
    lenses,
  };
}
