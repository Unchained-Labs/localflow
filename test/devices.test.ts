/**
 * The registry is an access-control list, so these tests are mostly about what
 * it REFUSES. A device that loads when it should not is the bug that matters.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findDevice, loadDevices } from "../src/devices.js";
import { SESSION_PREFIX, buildStartScript, shq } from "../src/remote.js";

function withFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lf-dev-"));
  const path = join(dir, "devices.json");
  writeFileSync(path, contents);
  return path;
}

describe("loadDevices", () => {
  it("treats a missing file as no devices, not as an error", () => {
    const { devices, error } = loadDevices(join(tmpdir(), "definitely-not-here", "devices.json"));
    expect(devices).toEqual([]);
    expect(error).toBeUndefined();
  });

  it("reads a well-formed device", () => {
    const path = withFile(JSON.stringify({ devices: [{ name: "spark", host: "spark.example.ts.net" }] }));
    const { devices, error } = loadDevices(path);
    expect(error).toBeUndefined();
    expect(devices).toEqual([{ name: "spark", host: "spark.example.ts.net", user: undefined, bin: undefined, cwd: undefined }]);
  });

  it("refuses a device carrying a credential, and says which field", () => {
    const path = withFile(
      JSON.stringify({ devices: [{ name: "spark", host: "h", password: "hunter2" }] }),
    );
    const { devices, error } = loadDevices(path);
    // The whole device is dropped. Loading it minus the password would work
    // against a key-based host and leave the secret sitting in the file.
    expect(devices).toEqual([]);
    expect(error).toMatch(/password/);
    expect(error).not.toMatch(/hunter2/); // never echo the value back
  });

  it.each(["passphrase", "key", "privateKey", "identity", "token"])(
    "refuses a device carrying %s",
    (field) => {
      const path = withFile(JSON.stringify({ devices: [{ name: "d", host: "h", [field]: "x" }] }));
      expect(loadDevices(path).devices).toEqual([]);
    },
  );

  it("refuses a name that could not be a tmux session", () => {
    const path = withFile(
      JSON.stringify({ devices: [{ name: "we;rm -rf /", host: "h" }, { name: "ok", host: "h" }] }),
    );
    const { devices, error } = loadDevices(path);
    expect(devices.map((d) => d.name)).toEqual(["ok"]);
    expect(error).toBeTruthy();
  });

  it("keeps the first of a duplicated name rather than letting the last win", () => {
    const path = withFile(
      JSON.stringify({ devices: [{ name: "a", host: "first" }, { name: "a", host: "second" }] }),
    );
    const { devices, error } = loadDevices(path);
    expect(devices).toHaveLength(1);
    expect(devices[0].host).toBe("first");
    expect(error).toMatch(/twice/);
  });

  it("survives malformed JSON without claiming there are no devices for another reason", () => {
    const path = withFile("{ not json");
    const { devices, error } = loadDevices(path);
    expect(devices).toEqual([]);
    expect(error).toMatch(/not valid JSON/);
  });
});

describe("findDevice", () => {
  const devices = [{ name: "spark", host: "spark.example.ts.net" }];

  it("resolves a declared name", () => {
    expect(findDevice(devices, "spark")?.host).toBe("spark.example.ts.net");
  });

  it("does NOT fall back to treating the name as a hostname", () => {
    // This is the access-control model in one assertion. If this ever returns a
    // device, the HTTP surface becomes an open SSH client.
    expect(findDevice(devices, "evil.example.com")).toBeUndefined();
    expect(findDevice(devices, "")).toBeUndefined();
    expect(findDevice(devices, null)).toBeUndefined();
    expect(findDevice(devices, { host: "evil" })).toBeUndefined();
  });
});

describe("shq", () => {
  it("neutralises every metacharacter that could end an argument", () => {
    for (const nasty of [
      `; rm -rf /`,
      `$(whoami)`,
      "`id`",
      `a b`,
      `x\ny`,
      `--flag`,
      `$HOME`,
    ]) {
      const quoted = shq(nasty);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
    }
  });

  it("survives the one character single quotes cannot contain", () => {
    // 'it'\''s' -- close, escaped quote, reopen.
    expect(shq(`it's`)).toBe(`'it'\\''s'`);
  });

  it("round-trips through a real shell", async () => {
    // The property that actually matters: whatever goes in comes back out as
    // exactly one argument with identical bytes. Asserting on the quoted string
    // alone would pass for a subtly wrong escape.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    for (const nasty of [`it's`, `$(echo pwned)`, "`id`", `a"b`, `x;y`, `\\`]) {
      const { stdout } = await run("sh", ["-c", `printf %s ${shq(nasty)}`]);
      expect(stdout).toBe(nasty);
    }
  });
});

describe("session naming", () => {
  it("prefixes sessions so the board never lists or kills foreign tmux sessions", () => {
    expect(SESSION_PREFIX).toBe("lf-");
  });
});

describe("buildStartScript, executed against a real shell", () => {
  /**
   * The point of this block: a hostile prompt must land in the prompt file as
   * inert bytes, and must not run. We stub tmux and claude on PATH so the script
   * can execute end-to-end without either installed, then read back what the
   * remote side would actually have handed to the binary.
   */
  async function runScript(prompt: string): Promise<{ file: string; arg: string }> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } = await import("node:fs");
    const run = promisify(execFile);

    const home = mkdtempSync(join(tmpdir(), "lf-home-"));
    const bin = mkdtempSync(join(tmpdir(), "lf-bin-"));

    // `tmux new-session ... <cmd>` -- record the command it was told to run, so
    // we can see the exact argument the binary would receive.
    writeFileSync(
      join(bin, "tmux"),
      `#!/bin/sh
case "$1" in
  has-session) exit 1 ;;
  new-session) shift; while [ "$#" -gt 1 ]; do shift; done; printf %s "$1" > "${home}/cmd" ;;
esac
exit 0
`,
    );
    chmodSync(join(bin, "tmux"), 0o755);
    // Stand-in for claude: record argv[2], which is what -p was given.
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf %s "$2" > "${home}/arg"\n`);
    chmodSync(join(bin, "claude"), 0o755);

    const script = buildStartScript({ name: "d", host: "h" }, "lf-t", prompt, ".");
    await run("sh", ["-c", script], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });

    const file = readFileSync(join(home, ".localflow/prompts/lf-t.txt"), "utf8");
    // Now actually run the command tmux was handed, and see what claude got.
    const cmd = readFileSync(join(home, "cmd"), "utf8");
    await run("sh", ["-c", cmd], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    const arg = existsSync(join(home, "arg")) ? readFileSync(join(home, "arg"), "utf8") : "";
    return { file, arg };
  }

  it("delivers a plain prompt unchanged", async () => {
    const { file, arg } = await runScript("summarise the repo");
    expect(file).toBe("summarise the repo");
    expect(arg).toBe("summarise the repo");
  });

  it.each([
    `"; touch /tmp/lf-pwned; echo "`,
    `$(touch /tmp/lf-pwned)`,
    "`touch /tmp/lf-pwned`",
    `'; touch /tmp/lf-pwned; '`,
    `line one\nline two; touch /tmp/lf-pwned`,
    `$HOME $USER \${PATH}`,
  ])("carries hostile prompt %j through as inert text", async (prompt) => {
    const { file, arg } = await runScript(prompt);
    // Byte-identical on both hops: into the file, and out to the binary.
    expect(file).toBe(prompt);
    expect(arg).toBe(prompt);
    const { existsSync } = await import("node:fs");
    expect(existsSync("/tmp/lf-pwned")).toBe(false);
  });
});
