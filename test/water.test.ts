/**
 * The soif bridge.
 *
 * These tests do not check soif's arithmetic — that is soif's job, and
 * duplicating its expectations here would be the same mistake as duplicating
 * its factors. What they pin is the *bridge*: that an absent soif is absent
 * rather than zero, that a guessed tier survives the trip instead of being
 * laundered into a confident number, and that a slice with no model never
 * reaches soif at all.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { humanize, probeSoif, waterFor } from "../src/water.js";

/** A fake soif that answers with whatever JSON we hand it. */
function fakeSoif(body: string, exit = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "lf-soif-"));
  const bin = join(dir, "soif");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "soif 9.9.9"; exit 0; fi
cat <<'JSON'
${body}
JSON
exit ${exit}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const KNOWN = JSON.stringify({
  water_ml: {
    total: { low: 1, mid: 10, high: 100 },
    onsite_cooling: { low: 0.1, mid: 1, high: 10 },
    offsite_electricity: { low: 0.9, mid: 9, high: 90 },
    embodied: { low: 0, mid: 0, high: 0 },
  },
  tier: "frontier",
  assumptions: ["region 'world' grid average"],
  factors_version: "2026.08",
});

const GUESSED = JSON.stringify({
  water_ml: { total: { low: 1, mid: 4, high: 40 } },
  tier: "large",
  assumptions: ["unknown model 'who-knows': assumed tier 'large' (pass tier= or active_params_b= to override)"],
  factors_version: "2026.08",
});

describe("probeSoif", () => {
  it("reports absence as absence, with the fix", async () => {
    const probe = await probeSoif({ bin: "/nonexistent/soif" });
    expect(probe.ok).toBe(false);
    expect(probe.detail).toMatch(/pip install soif-llm/);
  });
});

describe("waterFor", () => {
  it("returns no report rather than a report of zeroes when soif is missing", async () => {
    const r = await waterFor([{ model: "claude-opus-5", input: 100, output: 100, cached: 0 }], {
      bin: "/nonexistent/soif",
    });
    expect(r.ok).toBe(false);
    // The distinction that matters: a total of 0 would read as "this used no
    // water", which is false. There is simply no estimate.
    expect(r.total).toEqual({ low: 0, mid: 0, high: 0 });
    expect(r.byModel).toEqual([]);
    expect(r.detail).toMatch(/not installed/);
  });

  it("sums the models it could estimate", async () => {
    const bin = fakeSoif(KNOWN);
    const r = await waterFor(
      [
        { model: "claude-opus-5", input: 100, output: 100, cached: 0 },
        { model: "claude-haiku-4-5", input: 100, output: 100, cached: 0 },
      ],
      { bin },
    );
    expect(r.ok).toBe(true);
    expect(r.total).toEqual({ low: 2, mid: 20, high: 200 });
    expect(r.factorsVersion).toBe("2026.08");
  });

  it("carries a guessed tier through instead of laundering it", async () => {
    const bin = fakeSoif(GUESSED);
    const r = await waterFor([{ model: "who-knows", input: 100, output: 100, cached: 0 }], { bin });
    expect(r.byModel[0]!.assumed).toBe(true);
    expect(r.byModel[0]!.tier).toBe("large");
    expect(r.assumedModels).toEqual(["who-knows"]);
    // The number is still returned — an estimate with a stated guess beats no
    // estimate. It just must not look like the others.
    expect(r.total.mid).toBe(4);
  });

  it("does not flag a model soif actually knows", async () => {
    const bin = fakeSoif(KNOWN);
    const r = await waterFor([{ model: "claude-opus-5", input: 100, output: 100, cached: 0 }], { bin });
    expect(r.byModel[0]!.assumed).toBe(false);
    expect(r.assumedModels).toEqual([]);
  });

  it("never hands a nameless slice to soif", async () => {
    const bin = fakeSoif(KNOWN);
    const r = await waterFor(
      [
        { model: "claude-opus-5", input: 100, output: 100, cached: 0 },
        { model: "no model recorded", input: 9999, output: 9999, cached: 0 },
        { model: "", input: 50, output: 50, cached: 0 },
      ],
      { bin },
    );
    // Only the real model is estimated; the placeholder would otherwise have
    // been treated as a model name and given a confident-looking number.
    expect(r.byModel.map((s) => s.model)).toEqual(["claude-opus-5"]);
    expect(r.unknown).toHaveLength(2);
    expect(r.unknown[0]!.reason).toMatch(/never recorded a model/);
  });

  it("skips slices with no tokens rather than spawning a process for them", async () => {
    const bin = fakeSoif(KNOWN);
    const r = await waterFor([{ model: "claude-opus-5", input: 0, output: 0, cached: 0 }], { bin });
    expect(r.byModel).toEqual([]);
    expect(r.total.mid).toBe(0);
  });

  it("names a model soif refused, and leaves it out of the total", async () => {
    const bin = fakeSoif("not json at all", 1);
    const r = await waterFor([{ model: "weird", input: 100, output: 100, cached: 0 }], { bin });
    expect(r.ok).toBe(true);
    expect(r.total.mid).toBe(0);
    expect(r.unknown[0]!.model).toBe("weird");
  });
});

describe("humanize", () => {
  it("keeps the range attached to the number", () => {
    // soif's whole argument is that published figures span two orders of
    // magnitude. A bare midpoint would discard the honest part.
    expect(humanize({ low: 1, mid: 10, high: 100 })).toBe("10 mL (range 1.00 mL – 100 mL)");
  });

  it("switches to litres when millilitres stop meaning anything", () => {
    expect(humanize({ low: 2000, mid: 46000, high: 535000 })).toBe("46 L (range 2.0 L – 535 L)");
  });
});
