/**
 * Turning measured tokens into dollars.
 *
 * This is the *measuring* end of the same problem
 * [preflight](https://github.com/Unchained-Labs/preflight) solves at the
 * predicting end, and preflight is the source of truth for the numbers: CI
 * asserts this table against `preflight models --format otter-env` so the two
 * cannot drift. The multipliers below come from the same place.
 *
 * Cost is derived, never reported by the provider. So when no price is known for
 * a model this returns `null` and the board shows tokens with no dollar figure —
 * it does not show `$0.00`, which reads as "this run was free" rather than "we
 * do not know what this run cost".
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  introUntil?: string;
  standardInput?: number;
  standardOutput?: number;
  /** Who charges it. Only set on entries that did not come from the table below. */
  provider?: string;
}

/**
 * Where a price came from, which is as important as the price.
 *
 * `builtin` is verified in CI. `external` is a number the operator typed into
 * ~/.localflow/pricing.json and is exactly as current as they made it. `local`
 * is a real zero — hardware you own, no per-token bill — and is deliberately
 * distinguishable from `none`, which is "we do not know", the state that must
 * never render as a dollar figure.
 */
export type PriceOrigin = "builtin" | "external" | "local" | "none";

export interface PricedModel {
  price: ModelPrice | null;
  origin: PriceOrigin;
  /** For `local`, why the zero is a fact. Empty otherwise. */
  note?: string;
}

import { LOCAL_PRICE, LOCAL_REASON, isLocalModel, loadExternalPricing } from "./providers.js";

export const PRICING_VERIFIED = "2026-06-24";

export const PRICING: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5": {
    input: 2,
    output: 10,
    introUntil: "2026-08-31",
    standardInput: 3,
    standardOutput: 15,
  },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * Cache multipliers, established by measurement rather than by recall.
 *
 * `claude -p --output-format json` reports `total_cost_usd` for the run it just
 * did, which makes it an oracle: pick multipliers, price the reported token
 * counts, and see whether the arithmetic lands on the number the CLI printed.
 * With a single 1.25x cache-write multiplier it does not — it comes out about a
 * third light. With writes split by TTL it matches to ten decimal places, on
 * every sample tried:
 *
 *     531 input + 22188 cache-read + 3026 cache-write(1h) + 51 output, haiku
 *     1.25x -> $0.0067873000
 *     2.00x -> $0.0090568000
 *     CLI   -> $0.0090568000
 *
 * Claude Code writes 1-hour cache entries, so the 2x tier is the one that
 * applies to nearly every token on this board. `test/pricing.test.ts` re-runs
 * that check against the captured fixture, so if a rate changes the test says so
 * instead of the dashboard quietly lying about the bill.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/** Apply an intro rate's expiry, if it has one. */
function atDate(p: ModelPrice, asOf?: string): ModelPrice {
  if (p.introUntil && asOf && asOf > p.introUntil) {
    return { ...p, input: p.standardInput ?? p.input, output: p.standardOutput ?? p.output };
  }
  return p;
}

/**
 * External prices are read once per process.
 *
 * Re-reading per card would make a 40-card board do 40 stat() calls a poll for
 * a file that changes about twice a year. `reloadPricing()` exists for the
 * operator who just edited it and does not want to restart.
 */
let external = loadExternalPricing();

export function reloadPricing(): void {
  external = loadExternalPricing();
}

/** What the current external table knows, and whether it could be read at all. */
export function externalPricing() {
  return external;
}

/**
 * Resolve a model id to a price *and to where that price came from*.
 *
 * Order matters and is deliberate: the built-in table wins, because it is the
 * one CI verifies. An operator can add models it does not cover; they cannot
 * silently override a rate the build is asserting.
 */
export function resolvePrice(model: string | undefined | null, asOf?: string): PricedModel {
  if (!model) return { price: null, origin: "none" };

  const builtin = PRICING[model] ?? PRICING[model.replace(/-\d{8}$/, "")];
  if (builtin) return { price: atDate(builtin, asOf), origin: "builtin" };

  const supplied = external.models[model];
  if (supplied) return { price: atDate(supplied, asOf), origin: "external" };

  if (isLocalModel(model)) return { price: LOCAL_PRICE, origin: "local", note: LOCAL_REASON };

  return { price: null, origin: "none" };
}

/** Resolve a model id to a price, or null when we have no basis for one. */
export function priceOf(model: string | undefined | null, asOf?: string): ModelPrice | null {
  return resolvePrice(model, asOf).price;
}

export interface CostableUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** USD for a set of measured token counts, or null when the model is unpriced. */
export function costOf(usage: CostableUsage, model: string | undefined | null, asOf?: string): number | null {
  const p = priceOf(model, asOf);
  if (!p) return null;
  const inputUsd =
    (usage.input * p.input +
      usage.cacheRead * p.input * CACHE_READ_MULTIPLIER +
      usage.cacheWrite5m * p.input * CACHE_WRITE_5M_MULTIPLIER +
      usage.cacheWrite1h * p.input * CACHE_WRITE_1H_MULTIPLIER) /
    1e6;
  return inputUsd + (usage.output * p.output) / 1e6;
}

/**
 * Resolve a dated model id, as `modelUsage` reports it, to a price.
 * `claude-haiku-4-5-20251001` is the same model as `claude-haiku-4-5`.
 */
export function normaliseModel(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  if (PRICING[model]) return model;
  const undated = model.replace(/-\d{8}$/, "");
  if (PRICING[undated]) return undated;
  // Anything the wider resolution can price keeps its id verbatim: an external
  // table and a local alias are both keyed on the string the tool reported, and
  // stripping a date suffix off `gpt-5.2-20260101` would look up the wrong row.
  return resolvePrice(model).origin === "none" ? undefined : model;
}

/** Days since the table was verified. CI asserts a ceiling, as preflight does. */
export function pricingAgeDays(today: string): number {
  return Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${PRICING_VERIFIED}T00:00:00Z`)) / 86_400_000,
  );
}

/** The same string `preflight models --format otter-env` emits, for the CI check. */
export function toOtterEnv(asOf?: string): string {
  return Object.keys(PRICING)
    .map((id) => {
      const p = priceOf(id, asOf)!;
      return `${id}=${p.input}:${p.output}`;
    })
    .join(",");
}
