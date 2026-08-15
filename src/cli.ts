#!/usr/bin/env node
/** localflow CLI: serve the board, print it, or export what a session actually ran. */
import { Board } from "./board.js";
import { notesFor, observedSpec } from "./graph.js";
import { PRICING_VERIFIED, pricingAgeDays } from "./pricing.js";
import { LocalflowServer } from "./server.js";
import { renderBoard } from "./render.js";
import type { Task } from "./types.js";

const VERSION = "0.1.0";

const HELP = `localflow ${VERSION} — a Kanban board for the Claude Code sessions on this machine

USAGE
  localflow                        serve the board at http://127.0.0.1:7317
  localflow board                  print the board once and exit
  localflow graph <sessionId>      the graph that session actually ran, as a spec
  localflow calibrate              the measured cache hit rate, for preflight.json

OPTIONS
  --port N                 default 7317
  --host ADDR              default 127.0.0.1. Anything else exposes this to your network.
  --allow-actions          permit spawn / reprompt / reroute / stop. Off by default.
  --allow-root PATH        restrict spawn to a directory (repeatable)
  --history N              ended sessions to keep on the board (default 10)
  --tokens                 also write per-call token counts from calibrate. Off by
                           default: a session's context is not a worker's payload.
  --poll MS                refresh interval (default 2000)
  --otter URL              also show jobs from an Otter instance
  --format text|json       for board, graph and calibrate
  --as-of YYYY-MM-DD       price as of this date (intro rates expire)
  --version, --help

WATCHING IS THE DEFAULT
  localflow reads the session registry and your transcripts. It starts nothing and
  changes nothing until --allow-actions, and even then it binds to loopback and
  refuses cross-origin requests — this process can start Claude sessions, so a web
  page you happen to have open must not be able to reach it.

EXAMPLE
  localflow --allow-actions --allow-root ~/dev
  localflow graph f60740f7-4bda-4e90-9fd3-dbf03403068e | graphlint check -
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1]) out.push(argv[i + 1]!);
  });
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (argv.includes("--version")) {
    console.log(VERSION);
    return 0;
  }

  const format = flag(argv, "--format") ?? "text";
  const asOf = flag(argv, "--as-of") ?? new Date().toISOString().slice(0, 10);
  const history = flag(argv, "--history") ? Number(flag(argv, "--history")) : undefined;
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";

  const common = {
    asOf,
    history,
    url: flag(argv, "--otter"),
  };

  if (cmd === "board" || cmd === "graph" || cmd === "calibrate") {
    const board = new Board(common);
    let summary;
    try {
      summary = await board.poll();
    } catch (e) {
      console.error(`localflow: ${(e as Error).message}`);
      return 2;
    }

    if (cmd === "board") {
      if (format === "json") process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      else process.stdout.write(renderBoard(summary, { pricingVerified: PRICING_VERIFIED, asOf }));
      return 0;
    }

    if (cmd === "graph") {
      const id = argv.slice(1).find((a) => !a.startsWith("-"));
      const task = pickTask(summary.tasks, id);
      if (!task) {
        console.error(
          id ? `localflow: no session on the board matches "${id}"` : "usage: localflow graph <sessionId>",
        );
        return 2;
      }
      const spec = observedSpec(task);
      const notes = notesFor(task);
      if (format === "json") {
        process.stdout.write(`${JSON.stringify({ spec, notes }, null, 2)}\n`);
      } else {
        // Plain stdout is the spec itself, so it pipes straight into graphlint
        // and preflight. Commentary goes to stderr, where it cannot corrupt it.
        process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
        if (notes.length) {
          process.stderr.write(`\n  ${notes.length} note(s) on the graph that ran\n\n`);
          for (const n of notes) process.stderr.write(`  ${n.level === "warn" ? "!" : "·"} ${n.rule}: ${n.message}\n`);
          process.stderr.write("\n");
        }
      }
      return 0;
    }

    // calibrate
    const { calibrationFor } = await import("./calibrate.js");
    const cal = calibrationFor(summary.tasks, { tokens: argv.includes("--tokens") });
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(cal, null, 2)}\n`);
      return cal.refusal ? 1 : 0;
    }
    process.stdout.write(`${JSON.stringify(cal.config, null, 2)}\n`);
    process.stderr.write(cal.report);
    return cal.refusal ? 1 : 0;
  }

  if (cmd !== "serve") {
    console.error(`localflow: unknown command "${cmd}"`);
    return 2;
  }

  const age = pricingAgeDays(asOf);
  if (age > 120) {
    console.error(
      `localflow: the pricing table was verified ${age} days ago (${PRICING_VERIFIED}). ` +
        "Costs on the board are stale — see https://github.com/Unchained-Labs/preflight.",
    );
  }

  const host = flag(argv, "--host") ?? "127.0.0.1";
  const server = new LocalflowServer({
    ...common,
    port: Number(flag(argv, "--port") ?? 7317),
    host,
    allowActions: argv.includes("--allow-actions"),
    allowedRoots: flags(argv, "--allow-root"),
    pollMs: Number(flag(argv, "--poll") ?? 2000),
  });

  const { url } = await server.start();
  const n = server.snapshot?.totals.sessions ?? 0;
  console.log(`\n  localflow  ${url}`);
  console.log(`  ${n} session(s) on the board`);
  console.log(
    argv.includes("--allow-actions")
      ? "  actions enabled — this can start Claude sessions"
      : "  read-only — pass --allow-actions to spawn, reprompt, reroute or stop",
  );
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.log(`  ! bound to ${host}, not loopback. Anyone who can reach this port can read your transcripts.`);
  }
  console.log("");

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void server.stop().then(() => process.exit(0)));
  }
  return await new Promise<number>(() => {});
}

/** Match on full id, prefix, or session name — nobody types a UUID twice. */
function pickTask(tasks: Task[], id: string | undefined): Task | undefined {
  if (!id) return undefined;
  return (
    tasks.find((t) => t.id === id) ??
    tasks.find((t) => t.id.startsWith(id)) ??
    tasks.find((t) => t.name === id)
  );
}

main().then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (e) => {
    console.error(`localflow: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
