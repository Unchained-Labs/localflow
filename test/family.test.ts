/**
 * The graphlint and preflight bridge.
 *
 * These tests do not check either tool's rules — that is their job, and
 * asserting their findings here would be the same mistake as reimplementing
 * them. What they pin is the *bridge*, and specifically the three ways a bridge
 * like this quietly lies:
 *
 *   - an absent linter reported as a clean one,
 *   - a non-zero exit read as a failure, when for a linter it is the answer,
 *   - a finding about what localflow could not observe presented as a finding
 *     about the session.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NO_VERDICTS,
  estimateGap,
  estimateObserved,
  lensPlan,
  lintObserved,
  probeGraphlint,
} from "../src/family.js";
import type { ObservedSpec } from "../src/graph.js";

const SPEC: ObservedSpec = {
  name: "observed-test",
  description: "a graph",
  nodes: [{ id: "session", phase: "Session" }],
  edges: [],
  observed: {
    sessionId: "s1",
    fanouts: 1,
    widestFanout: 3,
    totalChildren: 3,
    failedChildren: 0,
    capturedAt: "2026-08-20T00:00:00.000Z",
  },
};

/** A fake tool that prints `body` and exits with `exit`. */
function fake(name: string, body: string, exit = 0): string {
  const dir = mkdtempSync(join(tmpdir(), `lf-${name}-`));
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
cat <<'JSON'
${body}
JSON
exit ${exit}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const FINDINGS = JSON.stringify({
  summary: { errors: 1, warnings: 2, infos: 0 },
  results: [
    {
      findings: [
        { rule: "correlated-verifiers", severity: "error", message: "three verifiers, one question" },
        { rule: "missing-schema", severity: "warning", message: 'Agent "session" returns free text.' },
        { rule: "missing-schema", severity: "warning", message: 'Agent "verify-1" returns free text.' },
      ],
    },
  ],
});

const ESTIMATE = JSON.stringify({
  after: {
    agents: { low: 4, expected: 9, high: 20 },
    usd: { low: 0.5, expected: 1.5, high: 4 },
    tokens: { input: 1000, output: 100 },
    nodes: [
      { id: "session", widthAssumed: true },
      { id: "verify-1", widthAssumed: false },
    ],
  },
});

describe("graphlint bridge", () => {
  it("reports an absent graphlint as absent, never as a clean lint", async () => {
    const r = await lintObserved(SPEC, { bin: "/nonexistent/graphlint" });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([]);
    // The distinction the whole module exists for: nothing ran, so nothing is
    // known — which must not read as "nothing is wrong".
    expect(r.detail).toMatch(/not installed/);
    expect(r.detail).toMatch(/nothing has linted/);
    expect(r.summary).toEqual({ errors: 0, warnings: 0, infos: 0 });
  });

  it("treats exit 1 as findings, not as failure", async () => {
    // graphlint exits 1 whenever a rule fires. A bridge that read that as an
    // error would discard exactly the runs worth reading.
    const r = await lintObserved(SPEC, { bin: fake("graphlint", FINDINGS, 1) });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("");
    expect(r.summary.errors).toBe(1);
    expect(r.findings.map((f) => f.rule)).toEqual([
      "correlated-verifiers",
      "missing-schema",
      "missing-schema",
    ]);
  });

  it("marks findings that are about what a transcript cannot record", async () => {
    const r = await lintObserved(SPEC, { bin: fake("graphlint", FINDINGS, 1) });
    const schema = r.findings.filter((f) => f.rule === "missing-schema");
    expect(schema).toHaveLength(2);
    for (const f of schema) expect(f.aboutTheInput).toMatch(/does not record/);
    // A real finding about the session carries no such caveat.
    expect(r.findings.find((f) => f.rule === "correlated-verifiers")?.aboutTheInput).toBeUndefined();
  });

  it("treats a usage error as a failure rather than an empty lint", async () => {
    const r = await lintObserved(SPEC, { bin: fake("graphlint", "not json", 2) });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/exited 2/);
  });

  it("does not invent findings when the output is not JSON", async () => {
    const r = await lintObserved(SPEC, { bin: fake("graphlint", "hello", 0) });
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.detail).toMatch(/did not return JSON/);
  });

  it("probes a missing binary without throwing", async () => {
    const p = await probeGraphlint({ bin: "/nonexistent/graphlint" });
    expect(p.ok).toBe(false);
    expect(p.version).toBeUndefined();
  });
});

describe("preflight bridge", () => {
  it("reports an absent preflight as absent", async () => {
    const r = await estimateObserved(SPEC, { bin: "/nonexistent/preflight" });
    expect(r.ok).toBe(false);
    expect(r.usd).toBeUndefined();
    expect(r.detail).toMatch(/nothing has priced/);
  });

  it("keeps the range rather than collapsing it to the midpoint", async () => {
    const r = await estimateObserved(SPEC, { bin: fake("preflight", ESTIMATE) });
    expect(r.ok).toBe(true);
    expect(r.usd).toEqual({ low: 0.5, expected: 1.5, high: 4 });
    expect(r.agents).toEqual({ low: 4, expected: 9, high: 20 });
  });

  it("names the nodes whose width was assumed rather than counting them", async () => {
    const r = await estimateObserved(SPEC, { bin: fake("preflight", ESTIMATE) });
    expect(r.assumedWidths).toEqual(["session"]);
  });
});

describe("the gap between predicted and measured", () => {
  const ok = { ok: true, detail: "", usd: { low: 0.5, expected: 1.5, high: 4 }, assumedWidths: [] };

  it("says nothing when the session could not be priced", () => {
    // An unpriced session has no gap to report, and reporting one would mean
    // treating "unknown" as a number.
    expect(estimateGap(null, ok)).toBeNull();
  });

  it("says nothing when preflight did not run", () => {
    expect(estimateGap(10, { ok: false, detail: "absent", assumedWidths: [] })).toBeNull();
  });

  it("calls a close estimate close", () => {
    const g = estimateGap(1.6, ok);
    expect(g?.note).toMatch(/close to what this session actually did/);
  });

  it("points at calibrate when the profile is the thing that is wrong", () => {
    const g = estimateGap(97.5, ok);
    expect(g?.ratio).toBeCloseTo(65, 0);
    expect(g?.note).toMatch(/65\.0x more/);
    expect(g?.note).toMatch(/localflow calibrate/);
  });

  it("reads a gap the other way round too", () => {
    const g = estimateGap(0.15, ok);
    expect(g?.note).toMatch(/10\.0x less/);
  });
});

const LENSES = JSON.stringify({
  domain: "generic",
  lenses: [
    {
      key: "refute",
      question: "Try to refute this.",
      catches: "plausible-but-wrong findings",
      model: "claude-opus-5",
    },
    { key: "evidence", question: "Quote the exact span.", catches: "hallucinated specifics", oracleHint: "grep it" },
    { key: "nope" },
  ],
});

describe("decorrelate bridge", () => {
  it("reports an absent decorrelate as absent", async () => {
    const r = await lensPlan("generic", { bin: "/nonexistent/decorrelate" });
    expect(r.ok).toBe(false);
    expect(r.lenses).toEqual([]);
    expect(r.detail).toMatch(/not installed/);
  });

  it("passes the plan through, dropping entries it cannot read", async () => {
    const r = await lensPlan("generic", { bin: fake("decorrelate", LENSES) });
    expect(r.ok).toBe(true);
    expect(r.domain).toBe("generic");
    // The third entry has no question, so there is nothing to show; a lens with
    // no question rendered as a blank row would look like a tool that broke.
    expect(r.lenses.map((l) => l.key)).toEqual(["refute", "evidence"]);
    expect(r.lenses[0]?.model).toBe("claude-opus-5");
    expect(r.lenses[1]?.oracleHint).toBe("grep it");
  });

  it("surfaces an unknown domain as decorrelate's own message", async () => {
    const bin = fake("decorrelate", 'decorrelate: unknown domain "zzz". Known: security, generic', 2);
    const r = await lensPlan("zzz", { bin });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/unknown domain/);
    // Not re-worded here: the list of domains lives in decorrelate, and a copy
    // of it in this repo is a copy that goes stale.
    expect(r.detail).toMatch(/Known:/);
  });

  it("states why report is not wired up rather than leaving it unexplained", () => {
    expect(NO_VERDICTS).toMatch(/decorrelate report/);
    expect(NO_VERDICTS).toMatch(/never what any of them concluded/);
  });
});
