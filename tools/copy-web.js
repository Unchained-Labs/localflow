#!/usr/bin/env node
/**
 * Assemble dist/web: the bundled app plus the static files it loads.
 *
 * The server refuses to serve anything outside this directory, so everything the
 * page needs has to land here — including the mark, which lives in assets/logo
 * because it is an artefact of the brand rather than of the build.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "web");
mkdirSync(out, { recursive: true });

const files = [
  ["web/index.html", "index.html"],
  ["web/app.css", "app.css"],
  ["web/tokens.css", "tokens.css"],
  ["assets/logo/favicon.svg", "favicon.svg"],
  ["assets/logo/lockup-horizontal.svg", "lockup-horizontal.svg"],
  ["assets/logo/mark-accent.svg", "mark-accent.svg"],
];

for (const [from, to] of files) {
  copyFileSync(join(root, from), join(out, to));
}
console.log(`   dist/web  ${files.length + 1} files`);
