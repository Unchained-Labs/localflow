/**
 * The archive exists to be correct months after the evidence is gone, so these
 * tests are mostly about the two ways an append-only log quietly lies: writing
 * rows nobody needed, and folding them back in the wrong order.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Archive, historyDir, historyTotals, pruneHistory, readHistory } from "../src/history.js";
import { ZERO_USAGE } from "../src/types.js";
import type { Task } from "../src/types.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "lf-hist-"));
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "s1",
    source: "claude",
    lane: "running",
    outcome: "unknown",
    title: "a job",
    name: "s1",
    cwd: "/home/e/apps/thing",
    status: "working",
    kind: "session",
    startedAt: 1_000,
    updatedAt: 2_000,
    turns: 3,
    queue: [],
    usage: { ...ZERO_USAGE, input: 100, output: 50 },
    costUsd: 0.25,
    cacheHitRate: null,
    tools: { Bash: 2 },
    toolErrors: 0,
    fanouts: [],
    ...over,
  } as Task;
}

/** A session row with every field at its zero, for tests that only care about dates. */
const emptyRecord = {
  type: "session",
  at: 0,
  id: "x",
  source: "claude",
  title: "t",
  name: "n",
  cwd: "/c",
  lane: "ended",
  outcome: "unknown",
  status: "",
  kind: "session",
  startedAt: 0,
  updatedAt: 0,
  turns: 0,
  usage: ZERO_USAGE,
  costUsd: null,
  tools: {},
  toolErrors: 0,
  fanouts: 0,
};

function rows(dir: string): string[] {
  const files = readdirSync(historyDir(dir));
  return files.flatMap((f) =>
    readFileSync(join(historyDir(dir), f), "utf8").split("\n").filter((l) => l.trim()),
  );
}

describe("Archive.record", () => {
  it("writes a row the first time it sees a session", () => {
    const dir = home();
    expect(new Archive(dir).record([task()])).toBe(1);
  });

  it("writes nothing for a poll in which nothing moved", () => {
    // The whole reason the archive is affordable. Without this a 2-second poll
    // appends 43,200 rows a day describing a machine that did nothing.
    const dir = home();
    const a = new Archive(dir);
    expect(a.record([task()])).toBe(1);
    expect(a.record([task()])).toBe(0);
    expect(a.record([task()])).toBe(0);
    expect(rows(dir)).toHaveLength(1);
  });

  it("writes again as soon as the session actually moves", () => {
    const dir = home();
    const a = new Archive(dir);
    a.record([task()]);
    expect(a.record([task({ turns: 4 })])).toBe(1);
    expect(a.record([task({ turns: 4, lane: "ended" })])).toBe(1);
    expect(a.record([task({ turns: 4, lane: "ended" })])).toBe(0);
  });

  it("degrades instead of throwing when the archive cannot be written", () => {
    // A board that stops rendering because ~/.localflow filled up has traded
    // the thing that works for the thing that records it.
    const dir = home();
    writeFileSync(join(dir, "history"), "not a directory");
    const a = new Archive(dir);
    expect(a.record([task()])).toBe(0);
    expect(a.error).toMatch(/not writable/);
  });
});

describe("readHistory", () => {
  it("treats a machine with no archive as empty, not as an error", () => {
    const r = readHistory({}, join(tmpdir(), "definitely-not-here"));
    expect(r.sessions).toEqual([]);
    expect(r.coverage.rows).toBe(0);
  });

  it("folds many observations of one session into its newest", () => {
    const dir = home();
    const a = new Archive(dir);
    a.record([task({ turns: 1, updatedAt: 1_000 })]);
    a.record([task({ turns: 9, updatedAt: 5_000 })]);
    const r = readHistory({}, dir);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].turns).toBe(9);
    expect(r.coverage.rows).toBe(2);
  });

  it("does not let a stale row overwrite a fresh one, whatever the file order", () => {
    // This is what makes backfill re-runnable: it appends August observations
    // in September, after rows that are newer than they are.
    const dir = home();
    new Archive(dir).record([task({ turns: 9, updatedAt: 5_000 })]);
    // A second Archive has an empty signature map, so it will happily append.
    new Archive(dir).record([task({ turns: 1, updatedAt: 1_000 })]);
    const r = readHistory({}, dir);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].turns).toBe(9);
  });

  it("skips a row torn in half by a kill without losing the file", () => {
    const dir = home();
    new Archive(dir).record([task()]);
    const f = join(historyDir(dir), readdirSync(historyDir(dir))[0]);
    writeFileSync(f, `${readFileSync(f, "utf8")}{"type":"session","id":"tru`);
    const r = readHistory({}, dir);
    expect(r.sessions).toHaveLength(1);
    expect(r.coverage.unreadable).toBe(1);
  });

  it("reports the window it can actually account for", () => {
    const dir = home();
    new Archive(dir).record([task({ startedAt: 1_000, updatedAt: 9_000 })]);
    const r = readHistory({}, dir);
    expect(r.coverage.from).toBe(1_000);
    expect(r.coverage.to).toBe(9_000);
  });

  it("says a window older than the archive is a floor rather than answering zero", () => {
    // burn.ts's rule, kept: a rate over a sample we do not have is not stated.
    const dir = home();
    new Archive(dir).record([task({ startedAt: 5_000, updatedAt: 6_000 })]);
    expect(readHistory({ since: 1 }, dir).partial).toBe(true);
    expect(readHistory({ since: 5_500 }, dir).partial).toBe(false);
  });

  it("filters by project and source", () => {
    const dir = home();
    const a = new Archive(dir);
    a.record([
      task({ id: "a", cwd: "/home/e/apps/alpha" }),
      task({ id: "b", cwd: "/home/e/apps/beta", source: "otter" }),
    ]);
    expect(readHistory({ project: "alpha" }, dir).sessions.map((s) => s.id)).toEqual(["a"]);
    expect(readHistory({ source: "otter" }, dir).sessions.map((s) => s.id)).toEqual(["b"]);
  });
});

describe("historyTotals", () => {
  it("counts unpriced sessions rather than pricing them at zero", () => {
    const dir = home();
    new Archive(dir).record([
      task({ id: "a", costUsd: 1.5 }),
      task({ id: "b", costUsd: null, cwd: "/other" }),
    ]);
    const t = historyTotals(readHistory({}, dir));
    expect(t.sessions).toBe(2);
    expect(t.costUsd).toBe(1.5);
    expect(t.unpriced).toBe(1);
    expect(t.projects).toBe(2);
  });

  it("has no cost at all when nothing could be priced", () => {
    const dir = home();
    new Archive(dir).record([task({ costUsd: null })]);
    expect(historyTotals(readHistory({}, dir)).costUsd).toBeNull();
  });
});

describe("limit", () => {
  it("cuts the page but not the arithmetic", () => {
    // `?limit=3` asking what this machine spent must not answer with what
    // three sessions spent.
    const dir = home();
    const a = new Archive(dir);
    a.record([
      task({ id: "a", costUsd: 1, updatedAt: 3_000 }),
      task({ id: "b", costUsd: 2, updatedAt: 2_000 }),
      task({ id: "c", costUsd: 4, updatedAt: 1_000 }),
    ]);
    const r = readHistory({ limit: 1 }, dir);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].id).toBe("a");
    expect(r.matched.sessions).toBe(3);
    expect(r.totals.sessions).toBe(3);
    expect(r.totals.costUsd).toBe(7);
  });
});

describe("windowed reads", () => {
  it("does not open a ledger that cannot contain anything in the window", () => {
    // What keeps a years-deep archive from being read into memory to answer a
    // question about this week.
    const dir = home();
    const d = historyDir(dir);
    mkdirSync(d, { recursive: true });
    const row = (id: string, updatedAt: number) =>
      `${JSON.stringify({ ...emptyRecord, id, startedAt: updatedAt, updatedAt })}\n`;
    writeFileSync(join(d, "2026-01.jsonl"), row("old", Date.UTC(2026, 0, 15)));
    writeFileSync(join(d, "2026-09.jsonl"), row("new", Date.UTC(2026, 8, 5)));

    const r = readHistory({ since: Date.UTC(2026, 8, 1) }, dir);
    expect(r.coverage.skipped).toBe(1);
    expect(r.coverage.files).toBe(1);
    expect(r.sessions.map((x) => x.id)).toEqual(["new"]);
  });

  it("still knows how far back the archive reaches when it skipped the old files", () => {
    // Otherwise a windowed query reports the archive as starting last Tuesday
    // and calls a perfectly answerable question a floor.
    const dir = home();
    const d = historyDir(dir);
    mkdirSync(d, { recursive: true });
    const row = (id: string, updatedAt: number) =>
      `${JSON.stringify({ ...emptyRecord, id, startedAt: updatedAt, updatedAt })}\n`;
    writeFileSync(join(d, "2026-01.jsonl"), row("old", Date.UTC(2026, 0, 15)));
    writeFileSync(join(d, "2026-09.jsonl"), row("new", Date.UTC(2026, 8, 5)));

    const r = readHistory({ since: Date.UTC(2026, 8, 1) }, dir);
    expect(r.coverage.archiveFrom).toBe(Date.UTC(2026, 0, 1));
    expect(r.partial).toBe(false);
    // But a window that really does predate the archive still says so.
    expect(readHistory({ since: Date.UTC(2025, 0, 1) }, dir).partial).toBe(true);
  });
});

describe("pruneHistory", () => {
  function months(dir: string, names: string[]): void {
    mkdirSync(historyDir(dir), { recursive: true });
    for (const n of names) writeFileSync(join(historyDir(dir), `${n}.jsonl`), "{}\n");
  }

  it("says what it would remove and removes nothing", () => {
    // Deleting history is the one operation here with no undo, so a command
    // that did it merely for being run is a command nobody dares try.
    const dir = home();
    months(dir, ["2026-01", "2026-02", "2026-03"]);
    const r = pruneHistory(1, { home: dir });
    expect(r.remove.map((x) => x.file)).toEqual(["2026-01.jsonl", "2026-02.jsonl"]);
    expect(r.applied).toBe(false);
    expect(readdirSync(historyDir(dir))).toHaveLength(3);
  });

  it("removes the oldest months when told to, and keeps the newest", () => {
    const dir = home();
    months(dir, ["2026-01", "2026-02", "2026-03"]);
    const r = pruneHistory(2, { home: dir, apply: true });
    expect(r.applied).toBe(true);
    expect(readdirSync(historyDir(dir)).sort()).toEqual(["2026-02.jsonl", "2026-03.jsonl"]);
  });

  it("refuses to keep zero months", () => {
    // `--keep 0` is a directory delete wearing a flag. It is not offered.
    const dir = home();
    months(dir, ["2026-01"]);
    expect(pruneHistory(0, { home: dir, apply: true }).remove).toEqual([]);
    expect(readdirSync(historyDir(dir))).toHaveLength(1);
  });

  it("leaves files it does not recognise alone", () => {
    const dir = home();
    months(dir, ["2026-01", "2026-02"]);
    writeFileSync(join(historyDir(dir), "notes.txt"), "keep me");
    pruneHistory(1, { home: dir, apply: true });
    expect(readdirSync(historyDir(dir)).sort()).toEqual(["2026-02.jsonl", "notes.txt"]);
  });
});
