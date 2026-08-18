/**
 * Prices for models this repo cannot verify itself.
 *
 * The built-in table in `pricing.ts` covers Anthropic, and it is checked in CI
 * against preflight so a rate change fails the build. That guarantee does not
 * extend to anyone else's rate card: nothing here can watch OpenAI's or
 * Google's pricing page, and a number typed from memory would be wrong on a
 * schedule nobody is tracking.
 *
 * So other vendors' prices are **data you supply**, not data this repo asserts.
 * Until you supply them the board shows tokens and no dollar figure, which is
 * the honest rendering of "nobody here knows what that cost" — the same reason
 * an unpriced Claude model shows `cost unknown` rather than `$0.00`.
 *
 * ~/.localflow/pricing.json:
 *
 *   {
 *     "verified": "2026-08-18",
 *     "models": {
 *       "gpt-5.2":        { "input": 1.25, "output": 10, "provider": "openai" },
 *       "gemini-3-pro":   { "input": 2.5,  "output": 15, "provider": "google" }
 *     }
 *   }
 *
 * Rates are USD per million tokens. `verified` is the date you last checked
 * them against the vendor's page; the board shows how stale that is, because a
 * price table with no age on it is indistinguishable from a correct one.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelPrice } from "./pricing.js";

export interface ExternalPricing {
  verified?: string;
  models: Record<string, ModelPrice>;
}

export interface LoadedPricing extends ExternalPricing {
  /** Where it came from, for the "why is this priced" question. */
  path?: string;
  /** Set when a file exists but could not be used. Shown, never swallowed. */
  error?: string;
}

const EMPTY: LoadedPricing = { models: {} };

export function pricingPath(): string {
  return process.env.LOCALFLOW_PRICING ?? join(homedir(), ".localflow", "pricing.json");
}

/**
 * Read the user's price table.
 *
 * A missing file is the normal case and returns an empty table. A file that is
 * present but malformed returns an empty table *and an error* — silently
 * ignoring it would leave someone staring at "cost unknown" with a perfectly
 * good pricing.json on disk and no clue why.
 */
export function loadExternalPricing(path = pricingPath()): LoadedPricing {
  if (!existsSync(path)) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ...EMPTY, path, error: `${path} is not valid JSON: ${(e as Error).message}` };
  }
  const table = parsed as ExternalPricing;
  if (!table || typeof table !== "object" || typeof table.models !== "object" || !table.models) {
    return { ...EMPTY, path, error: `${path} has no "models" object` };
  }
  const models: Record<string, ModelPrice> = {};
  const bad: string[] = [];
  for (const [id, price] of Object.entries(table.models)) {
    if (typeof price?.input === "number" && typeof price?.output === "number") {
      models[id] = price;
    } else {
      bad.push(id);
    }
  }
  return {
    models,
    verified: table.verified,
    path,
    // Named rather than dropped: a typo in one entry should not look like the
    // model was never in the file.
    error: bad.length ? `${path}: ignored ${bad.length} entr(y|ies) with no numeric input/output: ${bad.join(", ")}` : undefined,
  };
}

/**
 * Models served from hardware you already own.
 *
 * These are priced at zero, and that zero means something different from the
 * `null` an unpriced cloud model gets: there is no per-token bill, because the
 * bill was the machine. It is not free — the electricity and the Spark were
 * both real — but it is not per-token, and the board should not pretend a
 * number exists where the cost is a fixed asset.
 *
 * Matched by prefix so a served alias (`chat`) and the model behind it
 * (`deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`) both resolve.
 */
export const LOCAL_MODEL_PATTERNS = [
  /^chat$/i,
  /^fast$/i,
  /^deepseek-ai\//i,
  /^qwen\//i,
  /^meta-llama\//i,
  /^mistralai\//i,
  /^google\/gemma/i,
  /^ollama:/i,
];

export function isLocalModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return LOCAL_MODEL_PATTERNS.some((re) => re.test(model));
}

export const LOCAL_PRICE: ModelPrice = { input: 0, output: 0 };

/** Why a $0 figure is a fact here and not a missing value. */
export const LOCAL_REASON =
  "served locally — no per-token bill. The cost was the hardware, not the tokens.";

/** Days since a price table was last checked, or null when it never says. */
export function stalenessDays(verified: string | undefined, today: string): number | null {
  if (!verified) return null;
  const then = Date.parse(`${verified}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  return Math.floor((now - then) / 86_400_000);
}
