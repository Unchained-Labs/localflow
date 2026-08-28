/**
 * Reading the other tools on this machine.
 *
 * Three separate claims are pinned here, and they fail in different ways:
 *
 *   - **The json layout.** A tool that pretty-prints one object per file used to
 *     read as a tool that ran and cost nothing. That is the worst possible
 *     failure for this repo: not an error, a zero.
 *   - **Detection derives, it does not remember.** The suggestion must come from
 *     the sampled file. A test that asserted "Codex uses usage.input_tokens"
 *     would be asserting the thing this repo refuses to assert.
 *   - **Identity is a monogram.** Colour is only ever what the operator asked
 *     for, and an id nobody listed still gets a badge.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeclaredSourceAdapter, findGroups, foldGroup } from "../src/agents/jsonl.js";
import type { SourceSpec } from "../src/agents/jsonl.js";
import { glyphFor, identityFor, normaliseColor } from "../src/agents/identity.js";
import { inspect, leaves } from "../src/agents/detect.js";

function tree(): string {
  return mkdtempSync(join(tmpdir(), "lf-src-"));
}

/** An opencode-shaped store: one pretty-printed object per message, per session. */
function opencode(root: string, session: string, msgs: Record<string, unknown>[]): void {
  const dir = join(root, session);
  mkdirSync(dir, { recursive: true });
  msgs.forEach((m, i) => {
    writeFileSync(join(dir, `msg_${String(i + 1).padStart(3, "0")}.json`), JSON.stringify(m, null, 2));
  });
}

const OC_FIELDS = {
  input: "tokens.input",
  output: "tokens.output",
  cacheRead: "tokens.cache.read",
  model: "modelID",
  messageId: "id",
  timestamp: "time.created",
};

describe("the json layout", () => {
  it("makes one card per directory, not one per message", async () => {
    const root = tree();
    opencode(root, "ses_a", [
      { id: "m1", role: "user", time: { created: 1787600000000 } },
      {
        id: "m2",
        role: "assistant",
        modelID: "claude-sonnet-5",
        time: { created: 1787600060000 },
        tokens: { input: 100, output: 40 },
      },
    ]);
    opencode(root, "ses_b", [
      {
        id: "m3",
        role: "assistant",
        modelID: "claude-opus-5",
        time: { created: 1787600500000 },
        tokens: { input: 900, output: 5000 },
      },
    ]);

    const spec: SourceSpec = { id: "opencode", root, layout: "json", fields: OC_FIELDS };
    const { tasks } = await new DeclaredSourceAdapter(spec).poll({});

    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.title).sort()).toEqual(["ses_a", "ses_b"]);
    expect(tasks.find((t) => t.title === "ses_b")!.usage.output).toBe(5000);
  });

  it("totals a session across its message files", () => {
    const root = tree();
    opencode(root, "ses_a", [
      { id: "m1", tokens: { input: 10, output: 1 } },
      { id: "m2", tokens: { input: 20, output: 2 } },
      { id: "m3", tokens: { input: 30, output: 3 } },
    ]);
    const files = findGroups({ id: "x", root, layout: "json" })[0]!.files;

    const folded = foldGroup(files, OC_FIELDS, "json");

    expect(folded.usage.input).toBe(60);
    expect(folded.usage.output).toBe(6);
  });

  it("reads a pretty-printed file that the jsonl reader finds nothing in", () => {
    const root = tree();
    opencode(root, "ses_a", [{ id: "m1", tokens: { input: 500, output: 7 } }]);
    const file = findGroups({ id: "x", root, layout: "json" })[0]!.files[0]!;

    // The regression this layout exists for: line by line, a pretty-printed
    // object has no line that parses, so the session reads as free.
    expect(foldGroup([file], OC_FIELDS, "jsonl").usage.output).toBe(0);
    expect(foldGroup([file], OC_FIELDS, "json").usage.output).toBe(7);
  });

  it("says a session held no records rather than showing it as one that did nothing", async () => {
    const root = tree();
    const dir = join(root, "ses_a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "msg_001.json"), "{ not json at all");

    const { degraded } = await new DeclaredSourceAdapter({
      id: "oc",
      root,
      layout: "json",
      fields: OC_FIELDS,
    }).poll({});

    expect(degraded.map((d) => d.reason).join(" ")).toMatch(/would not parse/);
  });

  it("suggests the json layout when a jsonl source reads empty", async () => {
    const root = tree();
    writeFileSync(join(root, "a.jsonl"), JSON.stringify({ id: "m", tokens: { input: 1 } }, null, 2));

    const { degraded } = await new DeclaredSourceAdapter({ id: "x", root, fields: OC_FIELDS }).poll({});

    expect(degraded.map((d) => d.reason).join(" ")).toMatch(/"layout": "json"/);
  });

  it("still reads one session per file under the default layout", async () => {
    const root = tree();
    writeFileSync(
      join(root, "a.jsonl"),
      [
        JSON.stringify({ id: "m1", usage: { input_tokens: 5, output_tokens: 2 } }),
        JSON.stringify({ id: "m2", usage: { input_tokens: 7, output_tokens: 3 } }),
      ].join("\n"),
    );

    const { tasks } = await new DeclaredSourceAdapter({
      id: "codex",
      root,
      fields: { input: "usage.input_tokens", output: "usage.output_tokens", messageId: "id" },
    }).poll({});

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.usage.output).toBe(5);
  });
});

describe("detection", () => {
  it("derives field paths from the sampled file rather than from a table", () => {
    const root = tree();
    // Deliberately not the conventional names. If the suggestion still comes
    // back right, it came from these bytes.
    opencode(root, "ses_a", [
      {
        id: "m2",
        modelID: "claude-sonnet-5",
        time: { created: 1787600060000 },
        tokens: { input: 100, output: 40, cache: { read: 9 } },
      },
    ]);

    const f = inspect({ id: "opencode", label: "opencode", roots: [root], layout: "json" });

    expect(f.usable).toBe(true);
    expect(f.fields.input).toBe("tokens.input");
    expect(f.fields.output).toBe("tokens.output");
    expect(f.fields.cacheRead).toBe("tokens.cache.read");
    expect(f.fields.model).toBe("modelID");
    expect(f.sampled).toContain("msg_001.json");
  });

  it("also derives the api-style names, which are what most CLIs copied", () => {
    const root = tree();
    writeFileSync(
      join(root, "s.jsonl"),
      JSON.stringify({
        id: "x",
        model: "gpt-5.2",
        created_at: "2026-08-01T00:00:00Z",
        usage: { input_tokens: 3, output_tokens: 4, cached_tokens: 5 },
      }),
    );

    const f = inspect({ id: "codex", label: "Codex CLI", roots: [root], layout: "jsonl" });

    expect(f.fields.input).toBe("usage.input_tokens");
    expect(f.fields.cacheRead).toBe("usage.cached_tokens");
    expect(f.fields.timestamp).toBe("created_at");
  });

  it("refuses to name a field the sample did not contain", () => {
    const root = tree();
    writeFileSync(join(root, "s.jsonl"), JSON.stringify({ id: "x", note: "no counts in here" }));

    const f = inspect({ id: "codex", label: "Codex CLI", roots: [root], layout: "jsonl" });

    expect(f.usable).toBe(false);
    expect(f.fields.input).toBeUndefined();
    expect(f.fields.output).toBeUndefined();
    // and it says why, rather than emitting a source that produces free cards
    expect(f.note).toMatch(/nothing in them looked like a token count/);
    expect(f.paths.map((p) => p.path)).toContain("note");
  });

  it("unions across records, because only assistant turns carry token counts", () => {
    const root = tree();
    writeFileSync(
      join(root, "s.jsonl"),
      [
        JSON.stringify({ id: "u1", role: "user", text: "hi" }),
        JSON.stringify({ id: "a1", role: "assistant", usage: { input_tokens: 1, output_tokens: 2 } }),
      ].join("\n"),
    );

    // Reading only the first line would suggest nothing at all.
    expect(inspect({ id: "x", label: "x", roots: [root], layout: "jsonl" }).usable).toBe(true);
  });

  it("separates a tool that is absent from one whose store cannot be read", () => {
    const missing = inspect({
      id: "codex",
      label: "Codex CLI",
      roots: [join(tree(), "nope")],
      layout: "jsonl",
    });
    const sqlite = inspect({
      id: "cursor",
      label: "Cursor",
      roots: [],
      layout: "jsonl",
      unreadable: "Cursor keeps its conversations in SQLite",
    });

    expect(missing.note).toMatch(/not on this machine/);
    expect(sqlite.note).toMatch(/SQLite/);
    // Neither is usable, but they are not the same answer and must not read alike.
    expect(missing.note).not.toEqual(sqlite.note);
  });

  it("walks nested objects into dotted paths", () => {
    const got = leaves({ a: { b: { c: 1 } }, d: "x", e: [1, 2] });
    expect(got.map((l) => l.path).sort()).toEqual(["a.b.c", "d", "e"]);
  });
});

describe("source identity", () => {
  it("gives an unlisted id a monogram rather than nothing", () => {
    expect(glyphFor("my-team-runner")).toBe("mt");
    expect(glyphFor("zed")).toBe("ze");
    expect(glyphFor("q")).toBe("qq");
  });

  it("lets the operator's own label win over the built-in one", () => {
    expect(identityFor("codex").label).toBe("Codex CLI");
    expect(identityFor("codex", { label: "work laptop codex" }).label).toBe("work laptop codex");
  });

  it("carries a colour only when one was asked for, and only a real one", () => {
    expect(identityFor("codex").color).toBeUndefined();
    expect(identityFor("codex", { color: "#ff8800" }).color).toBe("#ff8800");
    expect(identityFor("codex", { color: "red; drop table" }).color).toBeUndefined();
    expect(normaliseColor("#abc")).toBe("#abc");
    expect(normaliseColor("rgb(1,2,3)")).toBeUndefined();
  });
});
