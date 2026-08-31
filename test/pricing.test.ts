import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  PRICING,
  PRICING_VERIFIED,
  costOf,
  normaliseModel,
  pricingAgeDays,
  priceOf,
  toOtterEnv,
} from "../src/pricing.js";
import { calibrationFor, MIN_SESSIONS } from "../src/calibrate.js";
import { advance, emptyState } from "../src/transcript.js";
import { toTask } from "../src/claude.js";
import { allowHostname, allowedHostnames, hostAllowed, originAllowed } from "../src/server.js";
import { checkCwd, checkPrompt, reprompt, stopSession } from "../src/actions.js";
import { laneForOtter } from "../src/otter.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

/**
 * The CLI's own cost figure, for a run it actually did.
 *
 * `claude -p --output-format json` reports `total_cost_usd`, which makes this an
 * oracle rather than an assertion: the arithmetic either lands on the number the
 * provider's own client printed, or it does not.
 */
interface HeadlessFixture {
  total_cost_usd: number;
  modelUsage: Record<
    string,
    { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }
  >;
  usage: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } };
}

const headless = JSON.parse(readFileSync(join(FIXTURES, "headless-result.json"), "utf8")) as HeadlessFixture;

describe("cost, checked against the CLI's own figure", () => {
  it("reproduces total_cost_usd exactly", () => {
    const [model, mu] = Object.entries(headless.modelUsage)[0]!;
    const cc = headless.usage.cache_creation ?? {};
    const ours = costOf(
      {
        input: mu.inputTokens,
        output: mu.outputTokens,
        cacheRead: mu.cacheReadInputTokens,
        cacheWrite5m: cc.ephemeral_5m_input_tokens ?? 0,
        cacheWrite1h: cc.ephemeral_1h_input_tokens ?? mu.cacheCreationInputTokens,
      },
      normaliseModel(model),
    );
    expect(ours).not.toBeNull();
    expect(ours!).toBeCloseTo(headless.total_cost_usd, 10);
  });

  it("gets it wrong with a single 1.25x cache-write multiplier", () => {
    // The reason the multipliers are split. This is not a hypothetical: a single
    // 1.25x is what preflight shipped, and against a real run it comes out about
    // a third light. If this test ever passes, the split has been undone.
    const [model, mu] = Object.entries(headless.modelUsage)[0]!;
    const p = priceOf(normaliseModel(model))!;
    const flat =
      (mu.inputTokens * p.input +
        mu.cacheReadInputTokens * p.input * CACHE_READ_MULTIPLIER +
        mu.cacheCreationInputTokens * p.input * CACHE_WRITE_5M_MULTIPLIER) /
        1e6 +
      (mu.outputTokens * p.output) / 1e6;
    expect(flat).toBeLessThan(headless.total_cost_usd * 0.9);
  });

  it("bills a 1-hour cache write above a 5-minute one", () => {
    expect(CACHE_WRITE_1H_MULTIPLIER).toBeGreaterThan(CACHE_WRITE_5M_MULTIPLIER);
    const base = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 1_000_000, cacheWrite1h: 0 };
    const long = { ...base, cacheWrite5m: 0, cacheWrite1h: 1_000_000 };
    expect(costOf(long, "claude-opus-5")!).toBeGreaterThan(costOf(base, "claude-opus-5")!);
  });

  it("reports null, never zero, for a model it cannot price", () => {
    // $0.00 reads as "this run was free". Null reads as "we do not know".
    expect(costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, "gpt-something")).toBeNull();
    expect(costOf({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, undefined)).toBeNull();
  });

  it("resolves the dated model ids transcripts actually contain", () => {
    // Without this, every haiku session on the board showed "cost unknown".
    expect(normaliseModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normaliseModel("claude-opus-5")).toBe("claude-opus-5");
    expect(normaliseModel("not-a-model")).toBeUndefined();
  });

  it("honours intro-rate expiry", () => {
    expect(priceOf("claude-sonnet-5", "2026-08-01")!.input).toBe(2);
    expect(priceOf("claude-sonnet-5", "2026-09-01")!.input).toBe(3);
  });

  it("emits the same shape preflight exports for Otter", () => {
    // CI asserts this string against `preflight models --format otter-env`, so
    // the two tables cannot drift apart unnoticed.
    const env = toOtterEnv("2026-08-01");
    expect(env).toMatch(/^claude-fable-5=10:50,/);
    expect(env.split(",")).toHaveLength(Object.keys(PRICING).length);
    for (const entry of env.split(",")) expect(entry).toMatch(/^[a-z0-9-]+=[\d.]+:[\d.]+$/);
  });

  it("knows how stale it is", () => {
    expect(pricingAgeDays(PRICING_VERIFIED)).toBe(0);
    expect(pricingAgeDays("2026-12-24")).toBeGreaterThan(150);
  });
});

describe("calibration for preflight", () => {
  function taskFrom(id: string) {
    const s = emptyState(id);
    advance(join(FIXTURES, "transcript.jsonl"), s);
    return toTask(id, undefined, s, undefined);
  }

  it("refuses below the sample floor and writes nothing", () => {
    const cal = calibrationFor([taskFrom("a")]);
    expect(cal.refusal).toBeDefined();
    expect(cal.config).toEqual({});
    expect(MIN_SESSIONS).toBeGreaterThan(1);
  });

  it("measures the cache hit rate rather than assuming it", () => {
    // This is the number preflight's own docs say cannot be derived from usage
    // rows — true of the rows it had, not of a Claude Code transcript.
    const cal = calibrationFor([taskFrom("a"), taskFrom("b"), taskFrom("c")]);
    expect(cal.refusal).toBeUndefined();
    const profiles = cal.config.profiles as Record<string, { cacheHitRate: number }>;
    for (const kind of ["scope", "worker", "verifier", "synthesis"]) {
      expect(profiles[kind]!.cacheHitRate, kind).toBeGreaterThan(0.9);
    }
  });

  it("does not write token counts, because a session is not a worker", () => {
    // preflight's worker profile means one unit of work and defaults to 8k
    // input. An interactive session measures hundreds of thousands, because by
    // call two hundred the context *is* the conversation. Both are correct;
    // writing the second into the first is a 40x error wearing the authority of
    // a measurement.
    const cal = calibrationFor([taskFrom("a"), taskFrom("b"), taskFrom("c")]);
    const worker = (cal.config.profiles as Record<string, Record<string, number>>).worker!;
    expect(worker.input).toBeUndefined();
    expect(worker.output).toBeUndefined();
    expect(cal.measured.medianInputPerCall).toBeGreaterThan(0);
    expect(cal.report).toMatch(/reported, not written/);
  });

  it("writes them when explicitly asked", () => {
    const cal = calibrationFor([taskFrom("a"), taskFrom("b"), taskFrom("c")], { tokens: true });
    const worker = (cal.config.profiles as Record<string, Record<string, number>>).worker!;
    expect(worker.input).toBeGreaterThan(0);
    expect(worker.cacheHitRate).toBeGreaterThan(0.9);
  });

  it("records provenance saying the rate was measured", () => {
    const cal = calibrationFor([taskFrom("a"), taskFrom("b"), taskFrom("c")], { date: "2026-08-16" });
    const prov = cal.config.$calibration as Record<string, unknown>;
    expect(prov.calibratedOn).toBe("2026-08-16");
    expect(String(prov.cacheHitRate)).toMatch(/measured/);
    expect(prov.sessions).toBe(3);
    expect(prov.tokenProfilesWritten).toBe(false);
    expect(String(prov.note)).toMatch(/not the same quantity/);
  });

  it("reports tokens per call, not per session", () => {
    // Per call. Feeding preflight session totals would produce a number inflated
    // by however long the conversation happened to run.
    const one = calibrationFor([taskFrom("a"), taskFrom("b"), taskFrom("c")]);
    const session = taskFrom("a");
    const sessionTotal =
      session.usage.input + session.usage.cacheRead + session.usage.cacheWrite1h + session.usage.cacheWrite5m;
    expect(one.measured.medianInputPerCall).toBeLessThan(sessionTotal);
  });
});

describe("the guards that stop a web page driving this", () => {
  it("accepts a Host that names this machine", () => {
    for (const h of ["localhost:7317", "127.0.0.1:7317", "[::1]:7317", "localhost"]) {
      expect(hostAllowed(h, 7317), h).toBe(true);
    }
  });

  it("refuses a Host that does not — which is how DNS rebinding shows up", () => {
    // An attacker resolves their own hostname to 127.0.0.1; the give-away is
    // that the browser still sends their name in Host.
    for (const h of ["evil.example", "evil.example:7317", "127.0.0.1.nip.io:7317", undefined]) {
      expect(hostAllowed(h, 7317), String(h)).toBe(false);
    }
  });

  it("refuses a Host naming the right machine on the wrong port", () => {
    expect(hostAllowed("localhost:9999", 7317)).toBe(false);
  });

  it("allows a request with no Origin, which is what curl and same-origin GETs send", () => {
    expect(originAllowed(undefined, 7317)).toBe(true);
    expect(originAllowed("null", 7317)).toBe(true);
  });

  it("refuses a cross-site Origin", () => {
    expect(originAllowed("https://evil.example", 7317)).toBe(false);
    expect(originAllowed("http://localhost:9999", 7317)).toBe(false);
    expect(originAllowed("not a url", 7317)).toBe(false);
  });

  it("allows our own page", () => {
    expect(originAllowed("http://127.0.0.1:7317", 7317)).toBe(true);
    expect(originAllowed("http://localhost:7317", 7317)).toBe(true);
  });
});

describe("actions", () => {
  it("rejects an empty prompt", () => {
    expect(checkPrompt("")).toMatch(/empty/);
    expect(checkPrompt("   ")).toMatch(/empty/);
    expect(checkPrompt("do a thing")).toBeNull();
  });

  it("keeps spawn inside the allowed roots", () => {
    expect(checkCwd("/tmp", { allowedRoots: ["/home/dev"] })).toMatch(/outside the allowed roots/);
    expect(checkCwd("/nope/nope", {})).toMatch(/no such directory/);
    expect(checkCwd("/tmp", {})).toBeNull();
  });

  it("refuses to reprompt a session that is mid-turn", async () => {
    // There is no supported way to inject a prompt into a running turn. Doing it
    // through the session's private socket would work until it did not.
    const r = await reprompt("abc", "hello", { status: "busy" });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/mid-turn/);
    expect(r.detail).toMatch(/reroute/i);
  });

  it("says so plainly when there is no process to interrupt", () => {
    expect(stopSession(undefined, "abc").detail).toMatch(/already ended/);
  });
});

describe("otter federation", () => {
  it("does not treat succeeded as a success lane", () => {
    // Otter's own README: status "succeeded" only means the process exited zero,
    // and the gap to delivery is the population that looked fine and shipped
    // nothing.
    expect(laneForOtter("succeeded")).toBe("ended");
    expect(laneForOtter("failed")).toBe("ended");
    expect(laneForOtter("running")).toBe("running");
    expect(laneForOtter("queued")).toBe("queued");
    expect(laneForOtter("anything-new")).toBe("ended");
  });
});

describe("host allow-list for reverse proxies", () => {
  // The Host check is what stops DNS rebinding, so widening it is the one
  // change here that could reopen a real hole. These pin the shape of the
  // widening: one name at a time, never a wildcard, and loopback unaffected.
  it("refuses a tailnet name until it is explicitly allowed", () => {
    expect(hostAllowed("localflow.example.ts.net", 7317)).toBe(false);
    allowHostname("localflow.example.ts.net");
    expect(hostAllowed("localflow.example.ts.net", 7317)).toBe(true);
  });

  it("ignores a wildcard, which would turn the check off entirely", () => {
    allowHostname("*");
    expect(hostAllowed("evil.example", 7317)).toBe(false);
    expect(allowedHostnames()).not.toContain("*");
  });

  it("still refuses an unrelated domain once one name is allowed", () => {
    allowHostname("localflow.example.ts.net");
    expect(hostAllowed("evil.example", 7317)).toBe(false);
    expect(hostAllowed("attacker.localflow.example.ts.net", 7317)).toBe(false);
  });

  it("accepts an allowed name on the proxy's port, not ours", () => {
    // Behind https the Host carries no port, or the proxy's — requiring OUR
    // port would reject every proxied request, which is the bug being fixed.
    allowHostname("localflow.example.ts.net");
    expect(hostAllowed("localflow.example.ts.net", 7317)).toBe(true);
    expect(hostAllowed("localflow.example.ts.net:443", 7317)).toBe(true);
  });

  it("leaves loopback behaviour exactly as it was", () => {
    allowHostname("localflow.example.ts.net");
    expect(hostAllowed("localhost:7317", 7317)).toBe(true);
    expect(hostAllowed("localhost:9999", 7317)).toBe(false);
    expect(hostAllowed(undefined, 7317)).toBe(false);
  });

  it("accepts an Origin from an allowed host, and no other", () => {
    allowHostname("localflow.example.ts.net");
    expect(originAllowed("https://localflow.example.ts.net", 7317)).toBe(true);
    expect(originAllowed("https://evil.example", 7317)).toBe(false);
  });
});
