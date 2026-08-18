/**
 * The declared-source adapter, against files whose shape we control.
 *
 * These fixtures are not a real Codex or Gemini transcript — nobody here has
 * one to copy. They are what the *contract* looks like: a JSONL file with a
 * model, a token count, and a message id, named by a sources.json entry. If
 * this passes, the adapter reads what it was told to read. Whether a given
 * tool's real files match is a question the person with that tool installed can
 * answer in about two minutes, which is the whole point of the design.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DeclaredSourceAdapter, dig, findFiles, foldFile, loadSources } from "../src/agents/jsonl.js";
import type { SourceSpec } from "../src/agents/jsonl.js";
import { AdapterRegistry } from "../src/agents/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "fixtures", "declared");

const FIELDS = {
  model: "model",
  input: "usage.input_tokens",
  output: "usage.output_tokens",
  cacheRead: "usage.cached_tokens",
  messageId: "id",
  timestamp: "created_at",
  title: "title",
  cwd: "cwd",
};

const spec = (over: Partial<SourceSpec> = {}): SourceSpec => ({
  id: "fixture",
  label: "Fixture CLI",
  root: ROOT,
  fields: FIELDS,
  // The fixtures are checked in with whatever mtime git gave them, so age
  // filtering has to be off for the test to be about parsing rather than clocks.
  maxAgeDays: 100_000,
  ...over,
});

describe("dig", () => {
  it("follows a dotted path", () => {
    expect(dig({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
  });

  it("returns undefined instead of throwing on a missing branch", () => {
    expect(dig({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(dig(null, "a")).toBeUndefined();
    expect(dig({ a: 1 }, undefined)).toBeUndefined();
  });
});

describe("foldFile", () => {
  const path = join(ROOT, "proj-a", "session-1.jsonl");

  it("counts each message id once", () => {
    // Three lines carry msg_1 with identical usage — the streaming re-emit
    // pattern that inflated output tokens 2.25x on a real transcript.
    const state = foldFile(path, FIELDS);
    expect(state.usage.output).toBe(300 + 700);
    expect(state.usage.input).toBe(1200 + 50);
    expect(state.usage.cacheRead).toBe(800 + 2400);
  });

  it("counts every line when no messageId field is declared", () => {
    const state = foldFile(path, { ...FIELDS, messageId: undefined });
    expect(state.usage.output).toBe(300 * 3 + 700);
    expect(state.deduped).toBe(false);
  });

  it("reports lines it could not parse rather than swallowing them", () => {
    expect(foldFile(path, FIELDS).unreadable).toBe(1);
  });

  it("picks up the first model, title and cwd it sees", () => {
    const state = foldFile(path, FIELDS);
    expect(state.model).toBe("gpt-5.2");
    expect(state.title).toBe("Refactor the parser");
    expect(state.cwd).toBe("/home/w/dev/parser");
  });

  it("returns empty state for a file it cannot read", () => {
    const state = foldFile(join(ROOT, "nope.jsonl"), FIELDS);
    expect(state.unreadable).toBe(1);
    expect(state.usage.output).toBe(0);
  });
});

describe("findFiles", () => {
  it("finds matching files under the root", () => {
    expect(findFiles(spec()).length).toBe(2);
  });

  it("honours the match pattern", () => {
    expect(findFiles(spec({ match: "session-2" })).length).toBe(1);
  });
});

describe("DeclaredSourceAdapter", () => {
  it("reports absence rather than failure when the tool is not installed", async () => {
    const probe = await new DeclaredSourceAdapter(spec({ root: "/nonexistent/xyz" })).probe();
    expect(probe.ok).toBe(false);
    expect(probe.absent).toBe(true);
  });

  it("produces one card per file, in the ended lane", async () => {
    const { tasks } = await new DeclaredSourceAdapter(spec()).poll({});
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.lane === "ended")).toBe(true);
    expect(tasks.every((t) => t.source === "fixture")).toBe(true);
  });

  it("leaves cost null for a model nobody has priced", async () => {
    const { tasks } = await new DeclaredSourceAdapter(spec()).poll({});
    // gpt-5.2 is not in the built-in table and no pricing.json is loaded in
    // tests, so the honest answer is null — never 0.
    for (const t of tasks) expect(t.costUsd).toBeNull();
  });

  it("says so when a source declares no token fields", async () => {
    const { degraded } = await new DeclaredSourceAdapter(spec({ fields: {} })).poll({});
    expect(degraded.some((d) => d.reason.includes("no token fields declared"))).toBe(true);
  });

  it("warns when a source cannot de-duplicate re-emitted usage", async () => {
    const { degraded } = await new DeclaredSourceAdapter(
      spec({ fields: { ...FIELDS, messageId: undefined } }),
    ).poll({});
    expect(degraded.some((d) => d.reason.includes("no fields.messageId"))).toBe(true);
  });

  it("surfaces unparseable lines as degraded, not as silence", async () => {
    const { degraded } = await new DeclaredSourceAdapter(spec()).poll({});
    expect(degraded.some((d) => d.reason.includes("would not parse"))).toBe(true);
  });
});

describe("loadSources", () => {
  it("treats a missing file as no sources, not an error", () => {
    expect(loadSources("/nonexistent/sources.json")).toEqual({ sources: [] });
  });

  it("reports malformed JSON instead of pretending the file is empty", () => {
    const result = loadSources(join(ROOT, "proj-a", "session-1.jsonl"));
    expect(result.sources).toEqual([]);
    expect(result.error).toMatch(/not valid JSON/);
  });
});

describe("AdapterRegistry", () => {
  it("keeps going when one adapter throws", async () => {
    const registry = new AdapterRegistry();
    registry.add(new DeclaredSourceAdapter(spec()));
    registry.add({
      id: "broken",
      label: "Broken",
      probe: async () => ({ ok: true, absent: false, detail: "" }),
      poll: async () => {
        throw new Error("disk on fire");
      },
    });

    const result = await registry.poll({});
    expect(result.tasks).toHaveLength(2); // the good adapter still delivered
    expect(result.degraded.some((d) => d.reason.includes("disk on fire"))).toBe(true);
  });

  it("does not report an absent tool as a problem", async () => {
    const registry = new AdapterRegistry();
    registry.add(new DeclaredSourceAdapter(spec({ id: "gone", root: "/nonexistent/xyz" })));
    const result = await registry.poll({});
    expect(result.degraded).toHaveLength(0);
    expect(result.adapters[0]!.probe.absent).toBe(true);
  });
});
