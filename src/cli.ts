#!/usr/bin/env node
/** localflow CLI: serve the board, print it, or export what a session actually ran. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Board, summarise } from "./board.js";
import { devicesPath, loadDevices } from "./devices.js";
import { Fleet, mirrorRoot } from "./mirror.js";
import { notesFor, observedSpec } from "./graph.js";
import { PRICING_VERIFIED, pricingAgeDays } from "./pricing.js";
import { LocalflowServer } from "./server.js";
import { renderBoard } from "./render.js";
import { computeMetrics } from "./metrics.js";
import { listSessions } from "./sessions.js";
import { humanize, waterFor } from "./water.js";
import { countTasks, readTasks } from "./tasks.js";
import type { Task } from "./types.js";

/**
 * The version, from the package rather than a second copy of it.
 *
 * It was a literal here, which meant `localflow --version` reported whatever
 * was last typed into this file rather than what was installed — the same
 * drift that let a sibling project publish a release under the previous
 * version number. Walks up because the file sits at `src/` in the repo and
 * `dist/src/` once built.
 */
function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return "0.0.0-unknown";
}

const VERSION = packageVersion();

const HELP = `localflow ${VERSION} — a Kanban board for the Claude Code sessions on this machine

USAGE
  localflow                        serve the board at http://127.0.0.1:7317
  localflow board                  print the board once and exit
  localflow graph <sessionId>      the graph that session actually ran, as a spec
  localflow review <sessionId>     lint and price that graph, via graphlint and preflight
  localflow workflows              the workflows in ~/.localflow/workflows
  localflow run <workflow>         run one, after linting and pricing it first
  localflow calibrate              the measured cache hit rate, for preflight.json
  localflow sessions [query]       every session on this machine, not just recent ones
  localflow tasks <sessionId>      that session's task list
  localflow metrics                the numbers behind the plots, as JSON
  localflow water                  freshwater these sessions cost, via soif

OPTIONS
  --port N                 default 7317
  --host ADDR              default 127.0.0.1. Anything else exposes this to your network.
  --public-port N          the port the browser will use, when it differs from --port
                           (a container published on another port, or a proxy). The
                           Host check still refuses the right machine on the wrong
                           port; this says which port is the right one.
  --allow-actions          permit spawn / reprompt / reroute / stop. Off by default.
  --allow-remote           permit starting Claude on a machine listed in
                           ~/.localflow/devices.json, over ssh, inside tmux so a
                           dropped connection cannot kill it. Off by default, and
                           separate from --allow-actions on purpose.
  --watch-remote           also show the sessions running on every machine in
                           ~/.localflow/devices.json. Read-only, and separate from
                           --allow-remote: watching copies those machines'
                           transcripts to ~/.localflow/mirror so they can be priced
                           by the same reader as local ones. Off by default.
  --remote-poll MS         how often devices are polled (default 10000)
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
  localflow review f60740f7          # the same pipe, both tools, one command
`;

/**
 * `workflows` and `run`.
 *
 * Separate from the board commands because neither needs a board: a workflow is
 * a file, and running one starts its own sessions rather than steering the ones
 * already here. `run` prints what the gates decided before it starts, because
 * "it is running" is the wrong first thing to learn about a fleet you are paying for.
 */
async function workflowCommand(cmd: string, argv: string[], format: string): Promise<number> {
  const { listWorkflows, readWorkflow, runWorkflow, workflowsDir } = await import("./workflow.js");

  if (cmd === "workflows") {
    const rows = listWorkflows();
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    if (!rows.length) {
      process.stdout.write(`\n  no workflows in ${workflowsDir()}\n\n`);
      return 0;
    }
    process.stdout.write(`\n  ${rows.length} workflow(s) in ${workflowsDir()}\n\n`);
    for (const r of rows) {
      const detail = r.error ? `unreadable — ${r.error}` : `${r.spec?.nodes.length ?? 0} node(s)`;
      process.stdout.write(`  ${r.name.padEnd(22)} ${detail}\n`);
    }
    process.stdout.write("\n");
    return 0;
  }

  const name = argv.slice(1).find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("usage: localflow run <workflow> [--force] [--allow-root PATH]");
    return 2;
  }
  const spec = readWorkflow(name);
  if (!spec) {
    console.error(`localflow: no workflow called "${name}" in ${workflowsDir()}`);
    return 2;
  }

  const run = await runWorkflow(spec, {
    allowedRoots: flags(argv, "--allow-root"),
    force: argv.includes("--force"),
    maxConcurrent: flag(argv, "--concurrency") ? Number(flag(argv, "--concurrency")) : undefined,
    onEvent: (e) => {
      if (format === "json" || e.type !== "node") return;
      const n = e.node;
      const where = `${n.id}${n.index === undefined ? "" : ` #${n.index + 1}`}`;
      if (n.state === "running") process.stderr.write(`  → ${where}\n`);
      else process.stderr.write(`  ${n.state === "done" ? "✓" : n.state === "failed" ? "✗" : "·"} ${where}${n.detail ? ` — ${n.detail}` : ""}\n`);
    },
  });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  } else {
    process.stdout.write(`\n  ${run.state}${run.detail ? ` — ${run.detail}` : ""}\n`);
    if (run.costUsd !== null) process.stdout.write(`  the CLI reported $${run.costUsd.toFixed(4)} across ${run.nodes.length} run(s)\n`);
    process.stdout.write("\n");
  }
  return run.state === "done" ? 0 : 1;
}

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

/**
 * The whole CLI, as a function of its arguments.
 *
 * `argv` is a parameter and the module only runs itself when it is the process
 * entry point, so a test can call this directly. Previously `main` read
 * `process.argv` itself and invoked on import, which meant importing this file
 * ran the program — and that is why the largest file in the project had no
 * tests at all.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
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

  if (cmd === "sessions") {
    const query = argv.slice(1).find((a) => !a.startsWith("-"));
    const archive = listSessions({ query, limit: Number(flag(argv, "--limit") ?? 0) });
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(archive, null, 2)}\n`);
      return 0;
    }
    for (const r of archive.rows) {
      const size = r.bytes ? `${(r.bytes / 1e6).toFixed(1)}MB` : "     -";
      process.stdout.write(
        `${r.live ? "*" : " "} ${r.sessionId}  ${size.padStart(7)}  ${r.cwd}\n`,
      );
    }
    // The count goes to stderr so `localflow sessions | wc -l` still counts rows.
    process.stderr.write(
      `\n  ${archive.total} session(s)${archive.truncated ? `, ${archive.truncated} not shown` : ""}` +
        `${archive.unreadable.length ? `, ${archive.unreadable.length} unreadable director(y|ies)` : ""}\n`,
    );
    return 0;
  }

  if (cmd === "tasks") {
    const id = argv.slice(1).find((a) => !a.startsWith("-"));
    if (!id) {
      console.error("usage: localflow tasks <sessionId>");
      return 2;
    }
    const list = readTasks(id);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ ...list, counts: countTasks(list) }, null, 2)}\n`);
      return 0;
    }
    if (!list.tasks.length) {
      process.stderr.write(`  no task list for session ${id}\n`);
      return 0;
    }
    for (const t of list.tasks) {
      process.stdout.write(`  ${t.id.padStart(3)}  ${t.status.padEnd(12)}  ${t.subject}\n`);
    }
    const c = countTasks(list);
    process.stderr.write(`\n  ${c.completed}/${c.total} done, ${c.in_progress} in progress\n`);
    return 0;
  }

  if (cmd === "workflows" || cmd === "run") return await workflowCommand(cmd, argv, format);

  if (
    cmd === "board" || cmd === "graph" || cmd === "review" ||
    cmd === "calibrate" || cmd === "metrics" || cmd === "water"
  ) {
    const board = new Board(common);
    let summary;
    try {
      summary = await board.poll();
    } catch (e) {
      console.error(`localflow: ${(e as Error).message}`);
      return 2;
    }

    // One-shot commands honour --watch-remote too. A flag that worked for the
    // server and was silently ignored by `localflow board` would be worse than
    // not having it: you would read a fleet-wide total that was one machine's.
    if (argv.includes("--watch-remote")) {
      const { devices, error: devErr } = loadDevices();
      const fleet = new Fleet({ history: common.history, asOf: common.asOf });
      fleet.sync(devices);
      const polls = await fleet.poll();
      const remote = polls.flatMap((p) => p.tasks);
      const degraded = [...summary.degraded, ...polls.flatMap((p) => p.degraded)];
      if (devErr) degraded.push({ id: "devices", reason: devErr });
      summary = summarise([...summary.tasks, ...remote], degraded, common.asOf);
    }

    if (cmd === "water") {
      const { computeMetrics: cm } = await import("./metrics.js");
      const report = await waterFor(
        cm(summary).byModel.map((m) => ({
          model: m.key,
          input: m.usage.input,
          output: m.usage.output,
          cached: m.usage.cacheRead,
        })),
        { region: flag(argv, "--region") },
      );
      if (format === "json") {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return report.ok ? 0 : 1;
      }
      if (!report.ok) {
        process.stderr.write(`  ${report.detail}\n`);
        return 1;
      }
      process.stdout.write(`\n  ${humanize(report.total)} of freshwater\n\n`);
      for (const s2 of report.byModel) {
        process.stdout.write(
          `  ${s2.model.padEnd(24)} ${humanize(s2.ml)}${s2.assumed ? "  [assumed tier]" : ""}\n`,
        );
      }
      // Provenance on stderr so `localflow water | ...` stays parseable, and so
      // the caveats are impossible to miss when a human runs it.
      if (report.assumedModels.length) {
        process.stderr.write(
          `\n  ! ${report.assumedModels.join(", ")}: soif had no factors and assumed a tier.\n` +
            "    Tier is worth roughly 30x across the range — treat those rows as the weakest part.\n",
        );
      }
      for (const u of report.unknown) {
        process.stderr.write(`\n  · ${u.model}: ${u.reason} (excluded from the total)\n`);
      }
      process.stderr.write(
        `\n  soif ${report.version ?? "?"}, factors ${report.factorsVersion ?? "?"}, region ${report.region}.\n` +
          "  Estimates, not measurements — read soif's METHODOLOGY.md before quoting them.\n\n",
      );
      return 0;
    }

    if (cmd === "metrics") {
      // JSON only: these are inputs to a chart, and an ASCII rendering of a
      // 60-bucket time series would be a worse chart than no chart.
      process.stdout.write(`${JSON.stringify(computeMetrics(summary), null, 2)}\n`);
      return 0;
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

    if (cmd === "review") {
      const id = argv.slice(1).find((a) => !a.startsWith("-"));
      const task = pickTask(summary.tasks, id);
      if (!task) {
        console.error(
          id ? `localflow: no session on the board matches "${id}"` : "usage: localflow review <sessionId>",
        );
        return 2;
      }

      const { lintObserved, estimateObserved, estimateGap, lensPlan, NO_VERDICTS } =
        await import("./family.js");
      const spec = observedSpec(task);
      const notes = notesFor(task);
      // Both run against the same document, and neither is asked to wait for
      // the other: one missing tool must not cost you the other's answer.
      const [lint, estimate] = await Promise.all([lintObserved(spec), estimateObserved(spec)]);
      const gap = estimateGap(task.costUsd, estimate);
      const correlated =
        notes.some((n) => n.rule === "correlated-verifiers") ||
        lint.findings.some((f) => f.rule === "correlated-verifiers");
      const lenses = correlated ? await lensPlan() : null;

      if (format === "json") {
        process.stdout.write(
          `${JSON.stringify(
            { spec, notes, lint, estimate, gap, lenses, noVerdicts: correlated ? NO_VERDICTS : null },
            null,
            2,
          )}\n`,
        );
        // Exit 1 when a rule fired, the way a linter should. Absence of the
        // linter is not a failing lint — it is exit 0 with a stated reason.
        return lint.ok && lint.summary.errors > 0 ? 1 : 0;
      }

      const out = process.stdout;
      out.write(`\n  ${task.title}\n`);
      out.write(`  ${task.fanouts.length} fan-out(s), ${spec.observed.totalChildren} agent(s), widest ${spec.observed.widestFanout}\n\n`);

      if (!lint.ok) {
        out.write(`  graphlint  ${lint.detail}\n`);
      } else {
        const { errors, warnings, infos } = lint.summary;
        out.write(`  graphlint ${lint.version ?? ""}  ${errors} error(s), ${warnings} warning(s), ${infos} info\n`);
        // The caveat is per rule, not per finding: `missing-schema` fires on
        // every node of an observed graph, and printing the same sentence four
        // times teaches the reader to skip it.
        const explained = new Set<string>();
        for (const f of lint.findings) {
          out.write(`    ${f.severity === "error" ? "✗" : "!"} ${f.rule}: ${f.message}\n`);
          if (f.aboutTheInput && !explained.has(f.rule)) {
            out.write(`      (${f.aboutTheInput})\n`);
            explained.add(f.rule);
          }
        }
      }
      out.write("\n");

      if (!estimate.ok) {
        out.write(`  preflight  ${estimate.detail}\n`);
      } else {
        const usd = estimate.usd;
        const agents = estimate.agents;
        out.write(`  preflight ${estimate.version ?? ""}\n`);
        if (agents) out.write(`    agents    ${agents.expected} expected (${agents.low}–${agents.high})\n`);
        if (usd) out.write(`    predicted $${usd.expected.toFixed(2)} ($${usd.low.toFixed(2)}–$${usd.high.toFixed(2)})\n`);
        out.write(`    measured  ${task.costUsd === null ? "unknown — no price for this model" : `$${task.costUsd.toFixed(2)}`}\n`);
        if (estimate.assumedWidths.length) {
          out.write(`    width assumed for ${estimate.assumedWidths.join(", ")}\n`);
        }
        if (gap) out.write(`\n  ${gap.note}\n`);
      }
      out.write("\n");

      if (correlated) {
        out.write(`  ${NO_VERDICTS}\n\n`);
        if (!lenses?.ok) {
          out.write(`  decorrelate  ${lenses?.detail ?? "not consulted"}\n`);
        } else {
          out.write(`  decorrelate ${lenses.version ?? ""} — a ${lenses.domain} lens plan for that panel\n`);
          for (const l of lenses.lenses) {
            out.write(`    ${l.key}${l.model ? `  ${l.model}` : ""}\n      ${l.question}\n`);
            if (l.oracleHint) out.write(`      oracle: ${l.oracleHint}\n`);
          }
          out.write("\n  Pick a domain that fits the work: `decorrelate lenses <domain>`.\n");
        }
        out.write("\n");
      }

      return lint.ok && lint.summary.errors > 0 ? 1 : 0;
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
    publicPort: flag(argv, "--public-port") ? Number(flag(argv, "--public-port")) : undefined,
    host,
    allowActions: argv.includes("--allow-actions"),
    allowRemote: argv.includes("--allow-remote"),
    watchRemote: argv.includes("--watch-remote"),
    remotePollMs: Number(flag(argv, "--remote-poll") ?? 10_000),
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
  if (argv.includes("--watch-remote")) {
    const { devices, error } = loadDevices();
    const watched = devices.filter((d) => d.monitor !== false);
    console.log(
      watched.length
        ? `  watching ${watched.length} device(s): ${watched.map((d) => d.name).join(", ")}` +
            ` — their transcripts are mirrored to ${mirrorRoot()}`
        : `  --watch-remote is on but no device in ${devicesPath()} is monitored`,
    );
    if (error) console.log(`  ! ${error}`);
  }
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

/**
 * True when this module is the program, rather than an import.
 *
 * Both sides go through `realpath` because `npm i -g` installs the bin as a
 * symlink: `process.argv[1]` is then the link in the bin directory while
 * `import.meta.url` is the real file under node_modules. Comparing them
 * unresolved made the installed CLI do nothing at all and exit 0 — the tests
 * could not see it, because they call `main()` directly and never go through
 * the shim.
 */
function isProgram(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved is not this file.
    return false;
  }
}

if (isProgram()) {
  main().then(
    (code) => {
      if (code !== undefined) process.exitCode = code;
    },
    (e) => {
      console.error(`localflow: ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}
