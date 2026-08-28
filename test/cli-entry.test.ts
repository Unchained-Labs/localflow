/**
 * The CLI as an installed program, not as an imported function.
 *
 * `test/cli.test.ts` calls `main()` directly, which is the right way to cover
 * the commands but cannot see whether the module ever decides to run itself.
 * It did not: `npm i -g` installs the bin as a symlink, so `process.argv[1]`
 * was the link and `import.meta.url` was the real file, the entry-point guard
 * compared them unresolved, and the installed CLI printed nothing and exited 0.
 *
 * This spawns the built file the way a shell would — once directly, once
 * through a symlink — and asserts it actually produces output.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BUILT = resolve("dist/src/cli.js");
const built = existsSync(BUILT);

// `pnpm build` runs before `pnpm test` in CI; skip rather than fail when a
// developer runs the suite alone.
describe.skipIf(!built)("the built CLI, spawned", () => {
  const run = (bin: string) =>
    execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim();

  it("prints its version when run directly", () => {
    expect(run(BUILT)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints its version when run through a symlink, as a global install does", () => {
    const dir = mkdtempSync(join(tmpdir(), "localflow-bin-"));
    const link = join(dir, "localflow");
    symlinkSync(BUILT, link);
    expect(run(link)).toMatch(/^\d+\.\d+\.\d+/);
  });
});
