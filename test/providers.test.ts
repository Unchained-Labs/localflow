/**
 * Where a price came from, and what happens when nobody knows one.
 *
 * The board's oldest rule is that an unpriced model shows `cost unknown` and
 * never `$0.00`. Adding other vendors is the obvious way to break it: a table
 * of guessed rates would price everything and be wrong, and a silent fallback
 * to zero would price everything and be worse. These tests pin the third
 * option — say you do not know — and pin the one case where a zero IS a fact.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { costOf, normaliseModel, resolvePrice } from "../src/pricing.js";
import { isLocalModel, loadExternalPricing, stalenessDays } from "../src/providers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "lf-pricing-"));

describe("resolvePrice", () => {
  it("prices a model from the built-in table and says so", () => {
    const r = resolvePrice("claude-opus-5");
    expect(r.origin).toBe("builtin");
    expect(r.price).toEqual({ input: 5, output: 25 });
  });

  it("resolves a dated model id to its undated row", () => {
    expect(resolvePrice("claude-haiku-4-5-20251001").price).toEqual({ input: 1, output: 5 });
  });

  it("returns null — not zero — for a model nobody has priced", () => {
    const r = resolvePrice("some-vendor/some-model-9");
    expect(r.price).toBeNull();
    expect(r.origin).toBe("none");
    expect(costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, "some-vendor/some-model-9")).toBeNull();
  });

  it("prices a locally served model at zero, with a reason", () => {
    const r = resolvePrice("chat");
    expect(r.origin).toBe("local");
    expect(r.price).toEqual({ input: 0, output: 0 });
    // The distinction that matters: `local` is a fact about the bill, `none` is
    // an admission of ignorance. Both render differently and must stay apart.
    expect(r.note).toMatch(/no per-token bill/);
  });

  it("recognises the model ids a local gateway actually serves", () => {
    expect(isLocalModel("deepseek-ai/DeepSeek-R1-0528-Qwen3-8B")).toBe(true);
    expect(isLocalModel("Qwen/Qwen3-Coder-30B-A3B-Instruct")).toBe(true);
    expect(isLocalModel("claude-opus-5")).toBe(false);
  });

  it("lets normaliseModel keep an id the wider resolution can price", () => {
    expect(normaliseModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normaliseModel("chat")).toBe("chat");
    expect(normaliseModel("nobody-knows-this")).toBeUndefined();
  });
});

describe("loadExternalPricing", () => {
  it("treats a missing file as no external prices", () => {
    expect(loadExternalPricing("/nonexistent/pricing.json").models).toEqual({});
  });

  it("reads a table the operator supplied", () => {
    const dir = tmp();
    const path = join(dir, "pricing.json");
    writeFileSync(path, JSON.stringify({ verified: "2026-08-01", models: { "gpt-5.2": { input: 1.25, output: 10 } } }));
    const loaded = loadExternalPricing(path);
    expect(loaded.models["gpt-5.2"]).toEqual({ input: 1.25, output: 10 });
    expect(loaded.verified).toBe("2026-08-01");
  });

  it("reports malformed JSON rather than silently pricing nothing", () => {
    const dir = tmp();
    const path = join(dir, "pricing.json");
    writeFileSync(path, "{ not json");
    expect(loadExternalPricing(path).error).toMatch(/not valid JSON/);
  });

  it("names entries it dropped instead of quietly losing them", () => {
    const dir = tmp();
    const path = join(dir, "pricing.json");
    writeFileSync(path, JSON.stringify({ models: { good: { input: 1, output: 2 }, bad: { input: "free" } } }));
    const loaded = loadExternalPricing(path);
    expect(Object.keys(loaded.models)).toEqual(["good"]);
    expect(loaded.error).toMatch(/bad/);
  });
});

describe("stalenessDays", () => {
  it("measures how old a price table is", () => {
    expect(stalenessDays("2026-08-01", "2026-08-18")).toBe(17);
  });

  it("returns null when the table never said", () => {
    expect(stalenessDays(undefined, "2026-08-18")).toBeNull();
  });
});
