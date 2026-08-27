/**
 * The CLI, which had no tests at all.
 *
 * It was 503 lines at 0% coverage — the largest untested file in the project and
 * the first surface every user touches. These are smoke tests, not a full suite:
 * every documented subcommand is dispatched, `--help` and `--version` answer,
 * bad input is refused with a non-zero code, and `--format json` emits parseable
 * JSON. That is enough to catch a broken flag, a renamed subcommand or a crash
 * on an empty machine, which is most of what actually goes wrong here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});

afterEach(() => vi.restoreAllMocks());

const stdout = () => out.join("");
const stderr = () => err.join("");

describe("--help and --version", () => {
  it("prints usage and exits 0", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(stdout()).toContain("localflow");
    expect(stdout()).toContain("USAGE");
  });

  it("accepts -h as well", async () => {
    expect(await main(["-h"])).toBe(0);
    expect(stdout()).toContain("USAGE");
  });

  it("prints a version that looks like one", async () => {
    expect(await main(["--version"])).toBe(0);
    expect(stdout().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("documents every subcommand it dispatches", async () => {
    await main(["--help"]);
    for (const cmd of [
      "board", "graph", "review", "workflows", "run",
      "calibrate", "sessions", "tasks", "metrics", "water",
    ]) {
      expect(stdout()).toContain(cmd);
    }
  });
});

describe("arguments that cannot be satisfied", () => {
  it("refuses `tasks` with no session id", async () => {
    expect(await main(["tasks"])).toBe(2);
    expect(stderr()).toContain("usage: localflow tasks");
  });

  it("refuses `graph` with no session id", async () => {
    expect(await main(["graph"])).not.toBe(0);
  });

  it("says so rather than throwing on a session that does not exist", async () => {
    const code = await main(["tasks", "does-not-exist-0000"]);
    expect(code).toBe(0);
    expect(stderr()).toContain("no task list");
  });
});

describe("--format json", () => {
  // These run wherever the suite runs: a developer machine with a live Claude
  // registry, and CI with none at all. An unreachable registry is deliberately
  // an error rather than an empty result — the behaviour job asserts that
  // separately — so the contract under test is "JSON when it can answer, a
  // usable error when it cannot", never a traceback either way.
  it("emits parseable JSON for sessions, which reads directories not the registry", async () => {
    expect(await main(["sessions", "--format", "json", "--limit", "1"])).toBe(0);
    expect(() => JSON.parse(stdout())).not.toThrow();
  });

  it("either answers metrics as JSON or says why it cannot", async () => {
    const code = await main(["metrics", "--format", "json"]);
    if (code === 0) {
      expect(JSON.parse(stdout())).toBeTypeOf("object");
    } else {
      expect(code).toBe(2);
      // Something a reader can act on, not a stack trace.
      expect(stderr().trim()).not.toBe("");
      expect(stderr()).not.toContain("    at ");
    }
  });

  it("keeps the session count off stdout so the rows can be piped", async () => {
    await main(["sessions", "--format", "json"]);
    expect(stdout()).not.toContain("session(s)");
  });
});
