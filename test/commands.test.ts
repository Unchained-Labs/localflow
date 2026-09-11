/**
 * The catalogue: what a workflow step can be, read from disk.
 *
 * Everything here is a file the test writes first. The module reads the same
 * places Claude Code does and nothing else, so the tests pin the layouts —
 * `commands/<ns>/<name>.md`, `skills/<name>/SKILL.md`, `agents/<name>.md`, and
 * the same three under a plugin tree — rather than a list typed from memory.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listCatalogue, parseFrontmatter } from "../src/commands.js";

function home(): string {
  return mkdtempSync(`${tmpdir()}/lf-cat-`);
}

function put(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

describe("frontmatter", () => {
  it("reads flat key: value pairs and hands back the body", () => {
    const { fields, body } = parseFrontmatter("---\nname: pdf\ndescription: \"Read PDFs.\"\n---\n# PDF\nhello");
    expect(fields).toEqual({ name: "pdf", description: "Read PDFs." });
    expect(body).toBe("# PDF\nhello");
  });

  it("treats a file with no block as all body", () => {
    expect(parseFrontmatter("just text").fields).toEqual({});
    expect(parseFrontmatter("just text").body).toBe("just text");
  });

  it("does not read an unterminated block as fields", () => {
    expect(parseFrontmatter("---\nname: x\nno end").fields).toEqual({});
  });
});

describe("listCatalogue", () => {
  it("finds commands, skills and agents in the user home", () => {
    const h = home();
    put(h, "commands/review.md", "---\ndescription: Review the diff.\nargument-hint: [focus]\n---\nReview.");
    put(h, "commands/frontend/component.md", "---\nmodel: sonnet\n---\n# Scaffold a component\nMake one.");
    put(h, "skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Read PDFs.\n---\n");
    put(h, "agents/reviewer.md", "---\ndescription: Read-only reviewer.\n---\n");

    const cat = listCatalogue({ home: h });
    expect(cat.commands.map((c) => c.invoke)).toEqual(["/component", "/review"]);
    expect(cat.commands.find((c) => c.name === "review")).toMatchObject({
      kind: "command", scope: "user", description: "Review the diff.", argumentHint: "[focus]",
    });
    // A namespaced command remembers its directory, and a file with no
    // description falls back to its first heading rather than to nothing.
    expect(cat.commands.find((c) => c.name === "component")).toMatchObject({
      namespace: "frontend", model: "sonnet", description: "Scaffold a component",
    });
    expect(cat.skills).toHaveLength(1);
    expect(cat.skills[0]).toMatchObject({ kind: "skill", invoke: "/pdf", description: "Read PDFs." });
    expect(cat.agents[0]).toMatchObject({ kind: "agent", name: "reviewer", invoke: "reviewer" });
    expect(cat.unreadable).toEqual([]);
  });

  it("lets a project definition shadow the user one of the same name", () => {
    const h = home();
    const proj = mkdtempSync(`${tmpdir()}/lf-proj-`);
    put(h, "commands/review.md", "---\ndescription: user version\n---\n");
    put(proj, ".claude/commands/review.md", "---\ndescription: project version\n---\n");
    const cat = listCatalogue({ home: h, cwd: proj });
    expect(cat.commands).toHaveLength(1);
    expect(cat.commands[0]).toMatchObject({ scope: "project", description: "project version" });
  });

  it("lists plugin entries beside, never instead of, your own", () => {
    const h = home();
    put(h, "commands/review.md", "---\ndescription: mine\n---\n");
    put(h, "plugins/cache/some-plugin/commands/review.md", "---\ndescription: theirs\n---\n");
    put(h, "plugins/cache/some-plugin/skills/deploy/SKILL.md", "---\ndescription: ship it\n---\n");
    const cat = listCatalogue({ home: h });
    expect(cat.commands.map((c) => [c.scope, c.description])).toEqual([["user", "mine"], ["plugin", "theirs"]]);
    expect(cat.skills[0]).toMatchObject({ kind: "skill", name: "deploy", scope: "plugin" });
  });

  it("uses the skill's own name when it declares one", () => {
    const h = home();
    put(h, "skills/synced/abc123/xlsx/SKILL.md", "---\nname: xlsx\ndescription: Spreadsheets.\n---\n");
    const cat = listCatalogue({ home: h });
    expect(cat.skills.map((s) => s.invoke)).toEqual(["/xlsx"]);
  });

  it("skips names that could not be typed as a command", () => {
    const h = home();
    put(h, "commands/has space.md", "x");
    put(h, "commands/ok.md", "x");
    expect(listCatalogue({ home: h }).commands.map((c) => c.name)).toEqual(["ok"]);
  });

  it("is empty, not broken, when nothing is installed", () => {
    const cat = listCatalogue({ home: home() });
    expect(cat.commands).toEqual([]);
    expect(cat.skills).toEqual([]);
    expect(cat.agents).toEqual([]);
    expect(cat.scanned).toEqual([]);
  });
});
