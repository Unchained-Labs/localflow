/**
 * How much water the answers cost, via soif.
 *
 * localflow already turns token counts into dollars. Water is the same shape —
 * tokens in, a number out — and the temptation is to write the arithmetic here
 * next to the pricing table. That would be the third time this ecosystem
 * implemented one thing twice, and the worst candidate for it: soif's factors
 * are versioned, sourced, and calibrated against Google's measured Gemini
 * figures, Epoch AI's GPT-4o analysis and Mistral's Large 2 LCA. A copy of that
 * would be wrong within a release and wrong silently.
 *
 * So this shells out to soif and does no arithmetic of its own. The cost is a
 * subprocess per model on an on-demand endpoint; the benefit is that a factor
 * update is `pip install -U soif-llm` rather than a patch to this file.
 *
 * Three rules, all inherited from how this repo already treats cost:
 *
 *   * **soif absent is absent, not zero.** No water section rather than a
 *     section full of zeroes, and the reason is stated once.
 *   * **A model soif does not know is named, not dropped.** Same as an unpriced
 *     model: excluded from the total and counted separately, so the total is
 *     visibly partial rather than quietly wrong.
 *   * **The range travels with the number.** soif's whole argument is that
 *     published per-prompt figures span two orders of magnitude, so it returns
 *     low/mid/high. Rendering only the midpoint would reintroduce exactly the
 *     false precision it exists to refuse.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** soif's uncertainty triple. Never collapse this to a scalar for display. */
export interface Triple {
  low: number;
  mid: number;
  high: number;
}

export interface WaterSlice {
  model: string;
  ml: Triple;
  /** Millilitres by component, for the "where does it go" breakdown. */
  onsiteMl?: Triple;
  offsiteMl?: Triple;
  embodiedMl?: Triple;
  /** soif's capability tier for this model — the main driver of the number. */
  tier?: string;
  /**
   * True when soif had no factors for this model and picked a tier for it.
   *
   * soif says so in its own assumptions rather than failing, which is the right
   * call for a library — an estimate with a stated guess beats an error. But
   * the guess has to survive the trip: a tier is worth roughly 30x across the
   * range, so a number resting on one is a different claim from a number
   * resting on published figures, and the board must not render them alike.
   */
  assumed: boolean;
  /** Every default soif leaned on, verbatim. */
  assumptions: string[];
}

export interface WaterReport {
  ok: boolean;
  /** Why there is no report. Empty when ok. */
  detail: string;
  version?: string;
  total: Triple;
  byModel: WaterSlice[];
  /** Models soif could not estimate at all, and why. Excluded from `total`. */
  unknown: { model: string; reason: string }[];
  /** soif's factor table version — the number these estimates are a function of. */
  factorsVersion?: string;
  /** Models whose estimate rests on an assumed tier rather than known factors. */
  assumedModels: string[];
  /** The hosting assumptions the numbers lean on. */
  region: string;
  includeEmbodied: boolean;
}

const ZERO: Triple = { low: 0, mid: 0, high: 0 };

/**
 * Placeholders the board uses when a transcript never named a model.
 *
 * These reach here as ordinary strings and there is nothing about them that
 * makes soif refuse — which is exactly why they have to be caught on this side.
 */
const UNKNOWN_MODEL = /^(no model recorded|unknown|undefined|null)$/i;

function add(a: Triple, b: Triple): Triple {
  return { low: a.low + b.low, mid: a.mid + b.mid, high: a.high + b.high };
}

function triple(v: unknown): Triple | undefined {
  const t = v as Partial<Triple> | undefined;
  if (!t || typeof t.low !== "number" || typeof t.mid !== "number" || typeof t.high !== "number") {
    return undefined;
  }
  return { low: t.low, mid: t.mid, high: t.high };
}

export interface WaterOptions {
  /** The soif binary. Overridable for tests and non-standard installs. */
  bin?: string;
  /**
   * Grid region for the off-site (power generation) term.
   *
   * Defaults to `world`, which is soif's own default and the honest answer for
   * a hosted model: the inference happened in the provider's data center, not
   * where you are sitting. Pin it only for models you host yourself.
   */
  region?: string;
  /** Include amortised manufacturing water. soif includes it by default. */
  includeEmbodied?: boolean;
  timeoutMs?: number;
}

export interface ModelUsage {
  model: string;
  input: number;
  output: number;
  cached: number;
}

function bin(opts: WaterOptions): string {
  return opts.bin ?? process.env.LOCALFLOW_SOIF_BIN ?? "soif";
}

/** Is soif installed? Absence is an answer, not a failure. */
export async function probeSoif(opts: WaterOptions = {}): Promise<{ ok: boolean; version?: string; detail: string }> {
  try {
    const { stdout } = await run(bin(opts), ["--version"], { timeout: 5_000 });
    return { ok: true, version: stdout.trim(), detail: "" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        detail:
          "soif is not installed, so there is no water estimate. `pip install soif-llm` " +
          "(the module is `soif`; the PyPI name was taken).",
      };
    }
    return { ok: false, detail: `could not run soif: ${(e as Error).message}` };
  }
}

/**
 * Water for a set of per-model token totals.
 *
 * One soif call per model rather than per session: the arithmetic is linear in
 * tokens, so summing the tokens first and estimating once gives the same answer
 * for a fraction of the process spawns. Cached tokens are passed through
 * because on a long agent session they are most of the input — leaving them out
 * would over-report by roughly the cache hit rate, which here is 98%.
 */
export async function waterFor(usage: ModelUsage[], opts: WaterOptions = {}): Promise<WaterReport> {
  const region = opts.region ?? process.env.LOCALFLOW_SOIF_REGION ?? "world";
  const includeEmbodied = opts.includeEmbodied ?? true;
  const base: WaterReport = {
    ok: false,
    detail: "",
    total: ZERO,
    byModel: [],
    unknown: [],
    assumedModels: [],
    region,
    includeEmbodied,
  };

  const probe = await probeSoif(opts);
  if (!probe.ok) return { ...base, detail: probe.detail };

  // Slices whose model is unknown must not be handed to soif. It would treat
  // the placeholder as a model name, find no factors, assume a tier, and return
  // a confident-looking number for work we cannot attribute to any model at
  // all. Named as unknown instead — the total is then visibly partial.
  const nameless = usage.filter(
    (u) => u.input + u.output > 0 && (!u.model || UNKNOWN_MODEL.test(u.model)),
  );
  const wanted = usage.filter(
    (u) => u.model && !UNKNOWN_MODEL.test(u.model) && u.input + u.output > 0,
  );
  const results = await Promise.all(
    wanted.map(async (u): Promise<{ slice?: WaterSlice; unknown?: { model: string; reason: string }; factorsVersion?: string }> => {
      const args = [
        "estimate",
        "-m", u.model,
        "-i", String(Math.round(u.input)),
        "-o", String(Math.round(u.output)),
        "--cached-tokens", String(Math.round(u.cached)),
        "--region", region,
        "--json",
      ];
      if (!includeEmbodied) args.push("--no-embodied");

      try {
        const { stdout } = await run(bin(opts), args, { timeout: opts.timeoutMs ?? 20_000, maxBuffer: 1 << 20 });
        const parsed = JSON.parse(stdout) as {
          water_ml?: Record<string, unknown>;
          tier?: string;
          assumptions?: string[];
          factors_version?: string;
        };
        const ml = triple(parsed.water_ml?.total);
        if (!ml) return { unknown: { model: u.model, reason: "soif returned no total" } };
        const assumptions = Array.isArray(parsed.assumptions) ? parsed.assumptions : [];
        return {
          factorsVersion: parsed.factors_version,
          slice: {
            model: u.model,
            ml,
            onsiteMl: triple(parsed.water_ml?.onsite_cooling),
            offsiteMl: triple(parsed.water_ml?.offsite_electricity),
            embodiedMl: triple(parsed.water_ml?.embodied),
            tier: parsed.tier,
            // soif phrases this one way and one way only. Matching on its own
            // wording is brittle by nature, so the fallback is to trust the
            // number — an estimate silently treated as solid is a smaller error
            // than one wrongly flagged as a guess on every row.
            assumed: assumptions.some((a) => a.toLowerCase().includes("unknown model")),
            assumptions,
          },
        };
      } catch (e) {
        // soif exits non-zero on a model it has no factors for. That is a real
        // answer — "I do not know this model" — and it belongs in the report
        // next to the total, not swallowed into a smaller number.
        const msg = (e as Error).message.split("\n").find((l) => l.trim()) ?? "unknown error";
        return { unknown: { model: u.model, reason: msg.slice(0, 160) } };
      }
    }),
  );

  const byModel = results.flatMap((r) => (r.slice ? [r.slice] : []));
  const unknown = [
    ...results.flatMap((r) => (r.unknown ? [r.unknown] : [])),
    ...nameless.map((u) => ({
      model: u.model || "(none)",
      reason: "the transcript never recorded a model, so there is nothing to estimate from",
    })),
  ];

  return {
    ...base,
    ok: true,
    version: probe.version,
    factorsVersion: results.find((r) => r.factorsVersion)?.factorsVersion,
    total: byModel.reduce((acc, s) => add(acc, s.ml), ZERO),
    byModel: byModel.sort((a, b) => b.ml.mid - a.ml.mid),
    unknown,
    assumedModels: byModel.filter((s) => s.assumed).map((s) => s.model),
  };
}

/**
 * Millilitres in words.
 *
 * Everyday units because millilitres of water do not mean anything to anyone at
 * the scale an agent session reaches. The range is always included: soif exists
 * because published figures span two orders of magnitude, and a bare midpoint
 * would throw away the only honest part of the estimate.
 */
export function humanize(ml: Triple): string {
  const unit = (n: number): string => {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} L`;
    if (n >= 10) return `${n.toFixed(0)} mL`;
    return `${n.toFixed(2)} mL`;
  };
  return `${unit(ml.mid)} (range ${unit(ml.low)} – ${unit(ml.high)})`;
}
