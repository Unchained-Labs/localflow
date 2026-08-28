/**
 * Watching another machine.
 *
 * The fake `ssh` here does not return a canned string. It takes the last
 * argument — which is exactly what real ssh hands to the remote shell — and
 * runs it, with `$HOME` pointed at a fixture. So what these tests exercise is
 * the generated shell source itself, against a real `find`, `stat`, `tail` and
 * `printf`.
 *
 * That matters more than usual here, because the two things most likely to be
 * wrong in this module are invisible to a mock: whether the quoting survives a
 * hostile filename, and whether the framing survives a transcript that contains
 * the framing marker. Asserting on the script as a string would pass happily
 * while both were broken.
 *
 * What is deliberately *not* tested is Claude Code or ssh. The remote registry
 * is a shell function printing fixture JSON; a suite that needed a second
 * machine would be measuring somebody's network.
 */
import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DeviceWatcher,
  Fleet,
  buildFetchScript,
  buildManifestScript,
  parseFrames,
  parseManifest,
  remoteRoot,
} from "../src/mirror.js";
import type { Device } from "../src/devices.js";
import type { SourceSpec } from "../src/agents/jsonl.js";

/** A machine: a `$HOME` with a .claude tree, and an `ssh` that runs scripts against it. */
function machine(): { home: string; ssh: string; mirror: string } {
  const dir = mkdtempSync(join(tmpdir(), "lf-mirror-"));
  const home = join(dir, "home");
  const mirror = join(dir, "mirror");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(mirror, { recursive: true });

  // The last argv element is the script, exactly as ssh would deliver it.
  const ssh = join(dir, "ssh");
  writeFileSync(
    ssh,
    [
      "#!/bin/sh",
      "for a in \"$@\"; do script=$a; done",
      `HOME=${JSON.stringify(home)}; export HOME`,
      // Not `$PATH`: this box has a real Claude Code on it, and inheriting the
      // caller's PATH would let the "Claude Code is not installed there" case
      // quietly find one and pass for the wrong reason.
      `PATH=${JSON.stringify(join(dir, "bin"))}:/usr/bin:/bin; export PATH`,
      'exec /bin/sh -c "$script"',
    ].join("\n"),
  );
  chmodSync(ssh, 0o755);
  mkdirSync(join(dir, "bin"), { recursive: true });
  return { home, ssh, mirror };
}

/** A `claude` on the far side whose `agents --json` prints `rows`. */
function remoteClaude(ssh: string, rows: unknown): void {
  const bin = join(ssh, "..", "bin", "claude");
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = agents ] && cat <<'JSON'\n${JSON.stringify(rows)}\nJSON\n`);
  chmodSync(bin, 0o755);
}

function transcript(home: string, slug: string, id: string, lines: unknown[]): string {
  const dir = join(home, ".claude", "projects", slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

/** An assistant message the transcript reader will count tokens from. */
function assistant(id: string, out: number) {
  return {
    type: "assistant",
    timestamp: "2026-08-20T10:00:00.000Z",
    message: {
      id,
      model: "claude-sonnet-5",
      usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 50 },
    },
  };
}

const DEVICE: Device = { name: "studio", host: "studio.local" };

function watcher(m: ReturnType<typeof machine>, over: Partial<Device> = {}) {
  return new DeviceWatcher({ ...DEVICE, ...over }, { root: m.mirror, sshBin: m.ssh, history: 5 });
}

describe("the manifest script", () => {
  it("reads the registry and stats every transcript", async () => {
    const m = machine();
    remoteClaude(m.ssh, [
      { pid: 1, sessionId: "aaa", cwd: "/w/x", kind: "interactive", startedAt: 1, name: "one", status: "busy" },
    ]);
    transcript(m.home, "-w-x", "aaa", [assistant("m1", 10)]);

    const w = watcher(m);
    const poll = await w.poll();

    expect(poll.reachable).toBe(true);
    expect(poll.tasks).toHaveLength(1);
    expect(poll.tasks[0]!.device).toBe("studio");
    expect(poll.tasks[0]!.remoteId).toBe("aaa");
    expect(poll.tasks[0]!.lane).toBe("running");
    expect(poll.tasks[0]!.usage.output).toBe(10);
  });

  it("says so when Claude Code is not installed over there, instead of showing an empty machine", async () => {
    const m = machine(); // no `claude` on the far side
    transcript(m.home, "-w-x", "bbb", [assistant("m1", 7)]);

    const poll = await watcher(m).poll();

    expect(poll.reachable).toBe(true);
    expect(poll.degraded.map((d) => d.reason).join(" ")).toMatch(/is Claude Code installed/);
    // The transcripts are still readable and still worth showing.
    expect(poll.tasks).toHaveLength(1);
  });

  it("honours a device whose Claude home is not $HOME/.claude", async () => {
    const m = machine();
    const elsewhere = join(m.home, "opt", "claude-state");
    mkdirSync(join(elsewhere, "projects", "-w-x"), { recursive: true });
    writeFileSync(
      join(elsewhere, "projects", "-w-x", "ccc.jsonl"),
      JSON.stringify(assistant("m1", 42)) + "\n",
    );

    const poll = await watcher(m, { home: elsewhere }).poll();

    expect(poll.tasks).toHaveLength(1);
    expect(poll.tasks[0]!.usage.output).toBe(42);
  });
});

describe("the mirror", () => {
  it("pulls only what was appended on the second poll", async () => {
    const m = machine();
    remoteClaude(m.ssh, [
      { pid: 1, sessionId: "aaa", cwd: "/w/x", kind: "interactive", startedAt: 1, name: "one", status: "busy" },
    ]);
    const path = transcript(m.home, "-w-x", "aaa", [assistant("m1", 10)]);

    const w = watcher(m);
    const first = await w.poll();
    expect(first.pulled).toBeGreaterThan(0);

    const second = await w.poll();
    expect(second.pulled).toBe(0); // nothing changed, nothing transferred

    writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(assistant("m2", 5)) + "\n");
    const third = await w.poll();

    expect(third.pulled).toBeGreaterThan(0);
    // 10 + 5, not 10 + 15: the appended bytes were folded in, not re-counted.
    expect(third.tasks[0]!.usage.output).toBe(15);
  });

  it("re-reads from the top when the far side replaces the file", async () => {
    const m = machine();
    remoteClaude(m.ssh, [
      { pid: 1, sessionId: "aaa", cwd: "/w/x", kind: "interactive", startedAt: 1, name: "one", status: "idle" },
    ]);
    const path = transcript(m.home, "-w-x", "aaa", [assistant("m1", 10), assistant("m2", 10)]);

    const w = watcher(m);
    await w.poll();

    // Shorter file, different content: resuming at the old offset would splice
    // one session's tail onto another's head.
    writeFileSync(path, JSON.stringify(assistant("m9", 3)) + "\n");
    const after = await w.poll();

    expect(after.tasks[0]!.usage.output).toBe(3);
  });

  it("marks a card partial when only the tail was pulled, so its cost reads as a floor", async () => {
    const m = machine();
    remoteClaude(m.ssh, [
      { pid: 1, sessionId: "aaa", cwd: "/w/x", kind: "interactive", startedAt: 1, name: "one", status: "idle" },
    ]);
    const rows = Array.from({ length: 200 }, (_, i) => assistant(`m${i}`, 1));
    transcript(m.home, "-w-x", "aaa", rows);

    const w = new DeviceWatcher(DEVICE, { root: m.mirror, sshBin: m.ssh, firstPull: 2_000 });
    const poll = await w.poll();

    expect(poll.tasks[0]!.partial).toBe(true);
    expect(poll.tasks[0]!.usage.output).toBeLessThan(200);
    expect(poll.degraded.map((d) => d.reason).join(" ")).toMatch(/floor, not a total/);
  });

  it("defers what will not fit in one poll and says how much, rather than dropping it", async () => {
    const m = machine();
    remoteClaude(m.ssh, [
      { pid: 1, sessionId: "aaa", cwd: "/w/a", kind: "interactive", startedAt: 1, name: "a", status: "idle" },
      { pid: 2, sessionId: "bbb", cwd: "/w/b", kind: "interactive", startedAt: 1, name: "b", status: "idle" },
      { pid: 3, sessionId: "ccc", cwd: "/w/c", kind: "interactive", startedAt: 1, name: "c", status: "idle" },
    ]);
    const rows = Array.from({ length: 40 }, (_, i) => assistant(`m${i}`, 1));
    transcript(m.home, "-w-a", "aaa", rows);
    transcript(m.home, "-w-b", "bbb", rows);
    transcript(m.home, "-w-c", "ccc", rows);

    const w = new DeviceWatcher(DEVICE, { root: m.mirror, sshBin: m.ssh, maxPerPoll: 3_000 });
    const first = await w.poll();

    expect(first.degraded.map((d) => d.reason).join(" ")).toMatch(/still syncing/);
    // The rest arrives, it is not lost.
    await w.poll();
    const third = await w.poll();
    expect(third.tasks.filter((t) => t.usage.output === 40)).toHaveLength(3);
  });

  it("keeps two machines' identically-named sessions apart", async () => {
    const a = machine();
    const b = machine();
    for (const m of [a, b]) {
      remoteClaude(m.ssh, [
        { pid: 1, sessionId: "same", cwd: "/w/x", kind: "interactive", startedAt: 1, name: "one", status: "idle" },
      ]);
    }
    transcript(a.home, "-w-x", "same", [assistant("m1", 10)]);
    transcript(b.home, "-w-x", "same", [assistant("m1", 99)]);

    const wa = new DeviceWatcher({ name: "alpha", host: "a" }, { root: a.mirror, sshBin: a.ssh });
    const wb = new DeviceWatcher({ name: "beta", host: "b" }, { root: b.mirror, sshBin: b.ssh });
    const [pa, pb] = [await wa.poll(), await wb.poll()];

    expect(pa.tasks[0]!.id).toBe("alpha:same");
    expect(pb.tasks[0]!.id).toBe("beta:same");
    expect(pa.tasks[0]!.usage.output).toBe(10);
    expect(pb.tasks[0]!.usage.output).toBe(99);
  });
});

describe("a device that stops answering", () => {
  it("keeps its cards and marks them stale rather than emptying the lane", async () => {
    const m = machine();
    remoteClaude(m.ssh, [
      { pid: 1, sessionId: "aaa", cwd: "/w/x", kind: "interactive", startedAt: 1, name: "one", status: "busy" },
    ]);
    transcript(m.home, "-w-x", "aaa", [assistant("m1", 10)]);

    const w = watcher(m);
    const good = await w.poll();
    expect(good.tasks).toHaveLength(1);

    // The machine goes away.
    writeFileSync(m.ssh, "#!/bin/sh\necho 'ssh: connect to host studio.local: No route to host' >&2\nexit 255\n");
    chmodSync(m.ssh, 0o755);
    const gone = await w.poll();

    expect(gone.reachable).toBe(false);
    expect(gone.tasks).toHaveLength(1);
    expect(gone.tasks[0]!.staleSince).toBe(good.syncedAt);
    expect(gone.degraded[0]!.reason).toMatch(/unreachable/);
    expect(gone.degraded[0]!.reason).toMatch(/last known state/);
  });

  it("reports the ssh error rather than a generic failure", async () => {
    const m = machine();
    writeFileSync(m.ssh, "#!/bin/sh\necho 'Permission denied (publickey).' >&2\nexit 255\n");
    chmodSync(m.ssh, 0o755);

    const poll = await watcher(m).poll();

    expect(poll.error).toBe("Permission denied (publickey).");
    expect(poll.tasks).toHaveLength(0);
  });
});

describe("what comes back from the far side is not trusted", () => {
  it("drops a stat row naming a path outside the tree it asked about", () => {
    const text = [
      "==LF-ROOT==",
      "/home/x/.claude",
      "==LF-REGISTRY==",
      "[]",
      "==LF-FILES==",
      "10\t1700000000\t/home/x/.claude/projects/-w-x/aaa.jsonl",
      "10\t1700000000\t/etc/shadow.jsonl",
      "10\t1700000000\t/home/x/.ssh/id_ed25519.jsonl",
      // Inside the string, outside the tree.
      "10\t1700000000\t/home/x/.claude/projects/../../.ssh/key.jsonl",
      // A different user's home, which shares no prefix with ours.
      "10\t1700000000\t/home/other/.claude/projects/-w/bbb.jsonl",
    ].join("\n");

    const m = parseManifest(text, DEVICE);

    expect(m.files.map((f) => f.id)).toEqual(["aaa"]);
  });

  it("keeps a path a stricter character rule would have silently dropped", () => {
    // A home directory with a `+` in it is ordinary and used to lose every
    // transcript on the machine, with nothing said about it.
    const text = [
      "==LF-ROOT==",
      "/home/a+b/.claude",
      "==LF-REGISTRY==",
      "[]",
      "==LF-FILES==",
      "10\t1\t/home/a+b/.claude/projects/-w/ok.jsonl",
    ].join("\n");

    expect(parseManifest(text, DEVICE).files.map((f) => f.id)).toEqual(["ok"]);
  });

  it("drops everything when the device did not say which root it used", () => {
    const text = [
      "==LF-REGISTRY==",
      "[]",
      "==LF-FILES==",
      "10\t1\t/h/.claude/projects/-w/ok.jsonl",
    ].join("\n");

    // No root section at all: this is not the answer we asked for, and reading
    // the file list out of it anyway would be trusting an unknown shape.
    expect(parseManifest(text, DEVICE).registryError).toMatch(/expected form/);
  });

  it("refuses a registry that is not an array instead of showing nothing", () => {
    const text = ["==LF-ROOT==", "/h/.claude", "==LF-REGISTRY==", '{"sessions":[]}', "==LF-FILES=="].join("\n");
    expect(parseManifest(text, DEVICE).registryError).toMatch(/did not parse/);
  });

  it("survives a device whose transcripts contain the framing marker", async () => {
    const m = machine();
    remoteClaude(m.ssh, [
      { pid: 1, sessionId: "aaa", cwd: "/w/x", kind: "interactive", startedAt: 1, name: "one", status: "idle" },
    ]);
    // A prompt that is this module's own framing. Scanning content for headers
    // would resynchronise here and mis-attribute everything after it.
    transcript(m.home, "-w-x", "aaa", [
      { type: "user", timestamp: "2026-08-20T10:00:00.000Z", message: { role: "user", content: "==LF aaa 999999" } },
      assistant("m1", 21),
    ]);

    const poll = await watcher(m).poll();

    expect(poll.tasks).toHaveLength(1);
    expect(poll.tasks[0]!.usage.output).toBe(21);
  });
});

describe("framing", () => {
  it("uses the declared byte count rather than searching for the next header", () => {
    const body = Buffer.from("==LF b 5\nnot a header at all\n");
    const buf = Buffer.concat([
      Buffer.from(`==LF a ${body.length}\n`),
      body,
      Buffer.from("==LF b 3\nxyz"),
    ]);

    const chunks = parseFrames(buf);

    expect(chunks.map((c) => c.id)).toEqual(["a", "b"]);
    expect(chunks[0]!.bytes.toString()).toBe(body.toString());
    expect(chunks[1]!.bytes.toString()).toBe("xyz");
  });

  it("flags a frame that ended early instead of silently keeping a short read", () => {
    const chunks = parseFrames(Buffer.from("==LF a 100\nonly-this"));
    expect(chunks[0]!.short).toBe(true);
    expect(chunks[0]!.bytes.toString()).toBe("only-this");
  });

  it("single-quotes every operator value it puts in a script", () => {
    const script = buildFetchScript([
      { file: { id: "aaa", path: "/h/.claude/projects/-w/aaa.jsonl", size: 10, mtime: 0 }, from: 4 },
    ]);
    expect(script).toContain("'/h/.claude/projects/-w/aaa.jsonl'");
    expect(script).toContain("LFO=4");
  });

  it("quotes a device's Claude home rather than interpolating it bare", () => {
    const script = buildManifestScript({ name: "x", host: "h", home: "/opt/state dir" });
    expect(script).toContain("'/opt/state dir'/projects");
  });
});

describe("declared sources on a watched device", () => {
  /** An opencode-shaped store under the fake machine's $HOME. */
  function remoteOpencode(home: string, session: string, msgs: Record<string, unknown>[]): string {
    const root = join(home, ".local", "share", "opencode", "storage", "message", session);
    mkdirSync(root, { recursive: true });
    msgs.forEach((m, i) =>
      writeFileSync(join(root, `msg_${i + 1}.json`), JSON.stringify(m, null, 2)),
    );
    return root;
  }

  const OPENCODE: SourceSpec = {
    id: "opencode",
    label: "opencode",
    root: "~/.local/share/opencode/storage/message",
    layout: "json",
    fields: { input: "tokens.input", output: "tokens.output", model: "modelID", messageId: "id" },
  };

  it("puts another machine's opencode sessions on the board", async () => {
    const m = machine();
    remoteClaude(m.ssh, []);
    remoteOpencode(m.home, "ses_remote", [
      { id: "m1", modelID: "claude-sonnet-5", tokens: { input: 100, output: 40 } },
      { id: "m2", modelID: "claude-sonnet-5", tokens: { input: 200, output: 60 } },
    ]);

    const w = new DeviceWatcher(DEVICE, { root: m.mirror, sshBin: m.ssh, sources: [OPENCODE] });
    const poll = await w.poll();

    const card = poll.tasks.find((t) => t.source === "opencode");
    expect(card).toBeDefined();
    expect(card!.device).toBe("studio");
    expect(card!.id.startsWith("studio:")).toBe(true);
    // Totalled across the session's message files by the same reader the local
    // board uses, which is the whole reason the files are mirrored.
    expect(card!.usage.output).toBe(100);
  });

  it("shows the path on the device, not the path of our copy", async () => {
    const m = machine();
    remoteClaude(m.ssh, []);
    remoteOpencode(m.home, "ses_remote", [{ id: "m1", tokens: { input: 1, output: 2 } }]);

    const poll = await new DeviceWatcher(DEVICE, {
      root: m.mirror,
      sshBin: m.ssh,
      sources: [OPENCODE],
    }).poll();

    const card = poll.tasks.find((t) => t.source === "opencode")!;
    // A drawer pointing at the mirror would send someone looking for a file at
    // a path that only exists on this machine.
    expect(card.transcriptPath).toContain(m.home);
    expect(card.transcriptPath).not.toContain(m.mirror);
  });

  it("watches nothing extra when no source was declared", async () => {
    const m = machine();
    remoteClaude(m.ssh, []);
    remoteOpencode(m.home, "ses_remote", [{ id: "m1", tokens: { input: 1, output: 2 } }]);

    const poll = await new DeviceWatcher(DEVICE, { root: m.mirror, sshBin: m.ssh }).poll();

    expect(poll.tasks.filter((t) => t.source === "opencode")).toHaveLength(0);
  });

  it("counts a session right when one of its files vanishes mid-poll", async () => {
    const m = machine();
    remoteClaude(m.ssh, []);
    const dir = remoteOpencode(m.home, "ses_remote", [
      { id: "m1", tokens: { input: 1, output: 10 } },
      { id: "m2", tokens: { input: 1, output: 20 } },
      { id: "m3", tokens: { input: 1, output: 30 } },
    ]);
    // The middle file goes away *between* the manifest and the fetch: the
    // manifest asks for three, the fetch answers with two. The wrapper deletes
    // it when it sees the fetch script go past, which is exactly that window.
    //
    // This pins the totals, not the frame indexing in mirror.ts -- that one is
    // about which path a byte lands in, and since folding reads content rather
    // than filenames it cannot be caught from out here. Said plainly because a
    // test named for a fix it does not exercise is worse than no test.
    const doomed = join(dir, "msg_2.json");
    writeFileSync(
      m.ssh,
      [
        "#!/bin/sh",
        'for a in "$@"; do script=$a; done',
        `HOME=${JSON.stringify(m.home)}; export HOME`,
        "PATH=/usr/bin:/bin; export PATH",
        `case "$script" in *"wc -c"*) rm -f ${JSON.stringify(doomed)} ;; esac`,
        'exec /bin/sh -c "$script"',
      ].join("\n"),
    );
    chmodSync(m.ssh, 0o755);

    // Declared without messageId, so nothing de-duplicates and a byte that got
    // counted twice would show up here rather than being folded away.
    const spec = { ...OPENCODE, fields: { ...OPENCODE.fields, messageId: undefined } };
    const w = new DeviceWatcher(DEVICE, { root: m.mirror, sshBin: m.ssh, sources: [spec] });
    await w.poll();
    const poll = await w.poll();

    const card = poll.tasks.find((t) => t.source === "opencode")!;
    expect(card.usage.output).toBe(40); // m1 + m3, each exactly once
  });

  it("drops a mirrored file the device no longer has", async () => {
    const m = machine();
    remoteClaude(m.ssh, []);
    const dir = remoteOpencode(m.home, "ses_remote", [
      { id: "m1", tokens: { input: 1, output: 10 } },
      { id: "m2", tokens: { input: 1, output: 20 } },
    ]);

    const w = new DeviceWatcher(DEVICE, { root: m.mirror, sshBin: m.ssh, sources: [OPENCODE] });
    expect((await w.poll()).tasks.find((t) => t.source === "opencode")!.usage.output).toBe(30);

    rmSync(join(dir, "msg_2.json"));

    // The declared-source adapter scans the mirror directory, so a file left
    // behind after it was deleted over there would keep being counted -- a card
    // billing you for work that is not on the machine any more.
    const after = await w.poll();
    expect(after.tasks.find((t) => t.source === "opencode")!.usage.output).toBe(10);
  });

  it("drops the whole card when the session is gone, rather than freezing it", async () => {
    const m = machine();
    remoteClaude(m.ssh, []);
    const dir = remoteOpencode(m.home, "ses_remote", [{ id: "m1", tokens: { input: 1, output: 10 } }]);

    const w = new DeviceWatcher(DEVICE, { root: m.mirror, sshBin: m.ssh, sources: [OPENCODE] });
    await w.poll();
    rmSync(dir, { recursive: true });

    const after = await w.poll();
    expect(after.tasks.filter((t) => t.source === "opencode")).toHaveLength(0);
    // And the directory goes with it. Under the json layout a directory *is* a
    // session, so one left behind is a session this machine still believes in.
    expect(existsSync(join(m.mirror, "studio", "sources", "opencode", "ses_remote"))).toBe(false);
  });

  it("expands ~ on the far side rather than looking for a directory called ~", () => {
    expect(remoteRoot("~/.codex/sessions")).toBe(`"$HOME"'/.codex/sessions'`);
    // An absolute root is quoted whole, with no expansion to do.
    expect(remoteRoot("/opt/codex")).toBe("'/opt/codex'");
    expect(remoteRoot("~")).toBe('"$HOME"');
  });

  it("drops a source file the device names outside the root it declared", () => {
    const text = [
      "==LF-ROOT==",
      "/home/x/.claude",
      "==LF-REGISTRY==",
      "[]",
      "==LF-FILES==",
      "==LF-SRC opencode",
      "/home/x/store",
      "10\t1\t/home/x/store/ses/a.json",
      "10\t1\t/etc/passwd",
      "10\t1\t/home/x/store/../../../etc/shadow.json",
      "10\t1\t/home/x/store-other/b.json",
    ].join("\n");

    const files = parseManifest(text, DEVICE).sources[0]!.files;

    // Only the one actually inside the declared root, and by its relative path,
    // because that relative path becomes a path on this disk.
    expect(files.map((f) => f.rel)).toEqual(["ses/a.json"]);
  });
});

describe("the fleet", () => {
  it("skips a device declared with monitor:false", async () => {
    const m = machine();
    const fleet = new Fleet({ root: m.mirror, sshBin: m.ssh });
    fleet.sync([
      { name: "watched", host: "a" },
      { name: "spawn-only", host: "b", monitor: false },
    ]);
    expect(fleet.size).toBe(1);
  });

  it("drops mirrored state when a device name is pointed at a different host", async () => {
    const m = machine();
    const fleet = new Fleet({ root: m.mirror, sshBin: m.ssh });
    fleet.sync([{ name: "studio", host: "old.local" }]);
    const before = fleet.size;
    fleet.sync([{ name: "studio", host: "new.local" }]);

    expect(before).toBe(1);
    expect(fleet.size).toBe(1);
    // A replaced watcher has no syncedAt yet — the old machine's mirror is not
    // inherited by whatever now answers to that name.
    const polls = await fleet.poll();
    expect(polls[0]!.device).toBe("studio");
  });

  it("removes a device that was deleted from devices.json", () => {
    const fleet = new Fleet();
    fleet.sync([{ name: "a", host: "a" }, { name: "b", host: "b" }]);
    fleet.sync([{ name: "a", host: "a" }]);
    expect(fleet.size).toBe(1);
  });
});
