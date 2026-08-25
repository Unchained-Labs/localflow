#!/usr/bin/env node
/**
 * A machine to film. Builds the synthetic home the demo reel is captured against.
 *
 * The reel used to require the author's own laptop: ten real sessions, a real
 * fan-out, a real five-hour block, real devices. That made it unrepeatable —
 * nobody else could rebuild the video, every feature that shipped made it
 * staler, and it put one person's prompts and working directories on the
 * project's front page.
 *
 * So the board in the reel is real code reading real files; the *files* are
 * written here. Everything localflow needs is redirectable by environment
 * variable, so nothing is stubbed inside the product itself:
 *
 *   CLAUDE_CONFIG_DIR      transcripts and the project tree
 *   LOCALFLOW_CLAUDE_BIN   the registry (`claude agents --json`)
 *   LOCALFLOW_HOME         devices.json
 *   LOCALFLOW_SOURCES      other tools' sessions
 *   LOCALFLOW_PRICING      rates for models this repo does not assert
 *   PATH                   an `ssh` that answers for the declared devices
 *
 * The two shims are the whole extent of the fake. `claude agents --json` prints
 * the registry rows below; `ssh` answers the probes `remote.ts` sends and
 * refuses everything else. Downstream of them — parsing, pricing, lanes,
 * fan-out, burn, blocks, water — is the shipping code doing its actual job on
 * files shaped like the ones it reads on a real machine.
 *
 * Two properties are copied from a real transcript rather than invented,
 * because the reader's correctness is defined against them: **usage is
 * re-emitted** as a message streams (three identical copies here, up to ten in
 * the wild — counting per line inflates output 2.25x), and **cache reads
 * dominate input** and grow as the context does.
 *
 * Timestamps are relative to now, because burn windows and the five-hour block
 * are relative to now: a fixture pinned to a fixed date films a board whose
 * every rate reads `unknown`.
 *
 * Usage: node tools/fixture.mjs <dir>   # writes <dir>, prints <dir>/env.sh
 */
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

if (!process.argv[2]) {
  console.error("usage: fixture.mjs <dir>");
  process.exit(2);
}
const out = resolve(process.argv[2]);

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.now();
const iso = (at) => new Date(at).toISOString();

/** Claude Code's project-folder slug. Mirrors slugForCwd in src/claude.ts. */
const slug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

/**
 * Seeded noise, so two runs of this file differ only by the clock.
 *
 * A fixture that jittered randomly would produce a slightly different board on
 * every capture, and "the numbers moved" would stop being a signal that
 * something in the reader changed.
 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const HOME = "/home/w";
const P = (p) => `${HOME}/${p}`;

// ---- the machine -------------------------------------------------------------
//
// Written to be a board worth looking at rather than a plausible average: all
// four lanes occupied, one session that has cost more than the rest combined,
// one fan-out wide enough to see, one model nobody here can price, and one
// served from hardware the operator already owns. Every caption in
// tools/mkdemo.py is a claim about this list — change a number and the caption
// that reads it out changes with it.

const sessions = [
  {
    id: "62173ece-8f2c-4a91-b0d5-2f77c1a4e310",
    name: "graph-claude-46",
    cwd: P("dev/graph-claude"),
    branch: "claude/observed-graphs-mt167r",
    status: "busy",
    kind: "background",
    pid: 48213,
    model: "claude-opus-5",
    effort: "high",
    title: "Reconstruct the fan-out a session actually performed",
    lastPrompt: "Emit the fan-out you reconstructed as a graphlint graph, then check it against the spec I wrote.",
    startedAt: NOW - 4.6 * HOUR,
    endedAt: NOW - 38_000,
    calls: 214,
    turns: 7,
    perCall: { input: 3_100, output: 2_900, cacheRead: 540_000, cacheWrite: 22_000, thinking: 1_100 },
    tools: { Bash: 186, Read: 141, Edit: 88, Grep: 52, Write: 17 },
    toolErrors: 23,
    // Ten Agent calls in four groups. One five wide with two children failing;
    // three of the four groups are a single call, which is the sequential
    // fan-out the graph beat is about.
    fanouts: [
      { atCall: 0.18, children: ["map the transcript reader"] },
      { atCall: 0.41, failed: 2, children: [
        "audit fan-out grouping", "audit cache accounting", "audit the pricing table",
        "audit lane mapping", "audit the queue reader",
      ] },
      // Three verifiers asked the same question in three wordings. localflow
      // does not lint graphs — graphlint does — but this is one of the few
      // things only the *observed* numbers can say, so it says it.
      { atCall: 0.72, children: [
        "verify the reconstruction is faithful",
        "verify the reconstruction is faithful, second pass",
        "verify the reconstruction is faithful, third pass",
      ] },
      { atCall: 0.97, children: ["write the round-trip test"] },
    ],
  },
  {
    id: "8a4f1d02-77b3-4e6c-9f10-5c2ea8b41d77",
    name: "billing-audit",
    cwd: P("work/billing"),
    branch: "audit/rate-limits",
    status: "busy",
    kind: "background",
    pid: 48755,
    model: "claude-sonnet-5",
    effort: "medium",
    title: "Audit the billing routes and open a PR with the fixes",
    lastPrompt: "Audit the billing routes and open a PR with the fixes.",
    startedAt: NOW - 54 * MIN,
    endedAt: NOW - 14_000,
    calls: 63,
    turns: 3,
    perCall: { input: 2_400, output: 2_100, cacheRead: 168_000, cacheWrite: 19_000, thinking: 700 },
    tools: { Read: 58, Grep: 31, Edit: 24, Bash: 22 },
    toolErrors: 2,
  },
  {
    id: "b91c74de-2a05-4f88-8ee1-70d3c9a6f215",
    name: "docs-sweep",
    cwd: P("dev/localflow"),
    branch: "docs/metrics-tab",
    status: "idle",
    kind: "interactive",
    pid: 47190,
    model: "claude-haiku-4-5-20251001",
    title: "Sweep the docs for anything the metrics tab made stale",
    lastPrompt: "Check every claim in the README against the code and list the ones that drifted.",
    startedAt: NOW - 2.2 * HOUR,
    endedAt: NOW - 6 * MIN,
    calls: 48,
    turns: 4,
    perCall: { input: 1_400, output: 1_600, cacheRead: 96_000, cacheWrite: 11_000 },
    tools: { Read: 44, Grep: 38, Edit: 19 },
    // Idle with prompts still waiting: the only thing on this board that is
    // genuinely queued rather than blocked on a person.
    queue: [
      "Then regenerate the sources.md table from the adapter's own defaults.",
      "And re-run the link checker over docs/ once that lands.",
    ],
  },
  {
    id: "f60740f7-3c19-4a2b-91de-8b5a70e4c633",
    name: "wardn-22",
    cwd: P("dev/bench2clanker"),
    branch: "claude/bench2baller-mt167r",
    status: "idle",
    kind: "interactive",
    pid: 46022,
    model: "claude-opus-5",
    effort: "high",
    title: "Should the socials repo be public with private docs, or private with a public mirror?",
    lastPrompt:
      "Public repo with the launch docs in a private submodule, or a private repo with a public mirror? " +
      "Pick one and tell me why before I keep going.",
    startedAt: NOW - 27 * HOUR,
    endedAt: NOW - 47 * MIN,
    calls: 176,
    turns: 11,
    perCall: { input: 3_400, output: 2_600, cacheRead: 488_000, cacheWrite: 26_000, thinking: 1_400 },
    tools: { Bash: 122, Read: 108, Edit: 71, Write: 24, Glob: 18 },
    toolErrors: 9,
    fanouts: [
      { atCall: 0.34, children: ["check what the org's other repos do", "check the submodule story"] },
    ],
  },
  {
    id: "1d5e9b70-6a44-4c02-b7f3-9e10d2c85a41",
    name: "spark-eval",
    cwd: P("dev/leharness"),
    status: "idle",
    kind: "background",
    pid: 45871,
    // Served from the operator's own hardware. Priced at 0, and that zero is a
    // different claim from the null the unpriced cloud model gets: there is no
    // per-token bill, because the bill was the machine.
    model: "ollama:qwen3-30b",
    title: "Score the local model against the same eval set",
    lastPrompt: "Run the eval set on the Spark and tell me where it loses to sonnet.",
    startedAt: NOW - 5.5 * HOUR,
    endedAt: NOW - 1.6 * HOUR,
    calls: 96,
    turns: 2,
    perCall: { input: 14_000, output: 3_800, cacheRead: 0, cacheWrite: 0 },
    tools: { Bash: 88, Write: 31, Read: 22 },
  },

  // ---- ended: still on disk, gone from the registry ---------------------------
  {
    id: "3e8b21ca-45d7-4a19-8c60-1f7b93e2d508",
    name: "water-wire",
    cwd: P("dev/localflow"),
    branch: "feat/water",
    model: "claude-opus-5",
    title: "Hand the token counts to soif rather than reimplementing its factors",
    lastPrompt: "Render the range soif returns, never the midpoint on its own.",
    startedAt: NOW - 9.4 * HOUR,
    endedAt: NOW - 6.2 * HOUR,
    calls: 88,
    turns: 6,
    perCall: { input: 2_800, output: 2_400, cacheRead: 372_000, cacheWrite: 21_000, thinking: 900 },
    tools: { Read: 61, Bash: 52, Edit: 37 },
    toolErrors: 4,
    // Eight wide on purpose: the drawer's graph collapses a group past six
    // children into a "+N" chip, and a fixture whose widest fan-out is five
    // never draws that chip, so nobody finds out it is broken.
    fanouts: [
      { atCall: 0.55, children: ["check soif's json shape", "check the tier-assumption wording"] },
      { atCall: 0.81, failed: 1, children: [
        "price opus against the table", "price sonnet against the table",
        "price haiku against the table", "price the local model",
        "check the region default", "check the embodied-water flag",
        "check the assumed-tier wording", "check the unknown-model path",
      ] },
    ],
  },
  {
    id: "c7a0f4b8-91e2-4d55-a3c1-6b8e02f7dd94",
    name: "tmux-remote",
    cwd: P("dev/localflow"),
    branch: "feat/devices",
    model: "claude-sonnet-5",
    title: "Start sessions on the Spark inside tmux so a dropped link cannot kill them",
    lastPrompt: "Prove the prompt never reaches a command line — run the generated script against a real shell.",
    startedAt: NOW - 14 * HOUR,
    endedAt: NOW - 11.5 * HOUR,
    calls: 74,
    turns: 8,
    perCall: { input: 2_100, output: 2_200, cacheRead: 214_000, cacheWrite: 17_000, thinking: 600 },
    tools: { Bash: 96, Edit: 41, Read: 33, Write: 12 },
    toolErrors: 11,
  },
  {
    id: "a2f6c318-0b74-4e91-9d2a-c5138f6b7e20",
    name: "burn-blocks",
    cwd: P("dev/localflow"),
    branch: "feat/burn",
    model: "claude-opus-5",
    title: "The rate the money is going, and the block it is going into",
    lastPrompt: "Floor the block start to the hour — that is upstream's rule, not a rounding convenience.",
    startedAt: NOW - 21 * HOUR,
    endedAt: NOW - 18.4 * HOUR,
    calls: 102,
    turns: 9,
    perCall: { input: 3_000, output: 2_700, cacheRead: 416_000, cacheWrite: 24_000, thinking: 1_200 },
    tools: { Read: 74, Bash: 66, Edit: 48, Grep: 21 },
    toolErrors: 6,
    fanouts: [
      { atCall: 0.46, failed: 1, children: [
        "derive the block boundary", "check the thin-sample rule", "check the straddling rule",
      ] },
    ],
  },
  {
    id: "d40b8e56-7c31-42af-b8e9-33a7c1054f6b",
    name: "sources-json",
    cwd: P("dev/localflow"),
    model: "claude-haiku-4-5-20251001",
    title: "Describe Codex's format instead of guessing at it",
    lastPrompt: "A guess that parses something is worse than no adapter — make the shape declared.",
    startedAt: NOW - 31 * HOUR,
    endedAt: NOW - 28.2 * HOUR,
    calls: 54,
    turns: 5,
    perCall: { input: 1_300, output: 1_500, cacheRead: 88_000, cacheWrite: 9_000 },
    tools: { Read: 39, Write: 14, Edit: 22, Bash: 17 },
  },
];

// ---- transcripts -------------------------------------------------------------

/**
 * One JSONL transcript.
 *
 * Every assistant message is written three times with the same id and the same
 * usage object, because that is what a streamed response looks like on disk.
 * Counting once per id is the correction the cost section of the README is
 * about, and a fixture that wrote each message once would film a reader that had
 * never had to be right about anything.
 */
function transcript(s) {
  const rand = rng([...s.id].reduce((a, c) => a + c.charCodeAt(0), 0));
  const lines = [];
  const base = { sessionId: s.id, cwd: s.cwd, version: "2.1.14", gitBranch: s.branch ?? "main" };
  const span = s.endedAt - s.startedAt;
  const at = (i) => s.startedAt + (span * i) / Math.max(1, s.calls - 1);

  lines.push({ ...base, type: "ai-title", aiTitle: s.title, timestamp: iso(s.startedAt) });
  lines.push({ ...base, type: "permission-mode", permissionMode: "acceptEdits", timestamp: iso(s.startedAt) });

  // Tool calls are dealt out across the session rather than bunched: a card's
  // "last: Bash" and the tools panel both come from where they landed.
  const budget = Object.entries(s.tools ?? {}).flatMap(([name, n]) => Array.from({ length: n }, () => name));
  for (let i = budget.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [budget[i], budget[j]] = [budget[j], budget[i]];
  }
  const perCallTools = Math.max(1, Math.round(budget.length / s.calls));

  const fanoutAt = new Map((s.fanouts ?? []).map((f) => [Math.floor(f.atCall * (s.calls - 1)), f]));
  const errorCalls = new Set();
  while (errorCalls.size < (s.toolErrors ?? 0)) errorCalls.add(Math.floor(rand() * s.calls));

  const turnEvery = Math.max(1, Math.floor(s.calls / Math.max(1, s.turns)));

  for (let i = 0; i < s.calls; i++) {
    const stamp = iso(at(i));
    const id = `msg_${s.name}_${i}`;

    if (i % turnEvery === 0) {
      lines.push({
        ...base,
        type: "user",
        timestamp: stamp,
        origin: { kind: "human" },
        message: { role: "user", content: [{ type: "text", text: s.lastPrompt }] },
      });
    }

    const content = [];
    const toolIds = [];
    for (let k = 0; k < perCallTools && budget.length; k++) {
      const name = budget.pop();
      const toolId = `${id}_t${k}`;
      toolIds.push(toolId);
      content.push({ type: "tool_use", id: toolId, name, input: {} });
    }

    const failed = [];
    const fan = fanoutAt.get(i);
    if (fan) {
      fan.children.forEach((description, k) => {
        const toolId = `${id}_a${k}`;
        if (k < (fan.failed ?? 0)) failed.push(toolId);
        content.push({
          type: "tool_use",
          id: toolId,
          name: "Agent",
          input: {
            description,
            prompt: `${description}. Report what you find and stop — do not edit anything.`,
            subagent_type: "Explore",
          },
        });
      });
    }
    if (errorCalls.has(i) && toolIds.length) failed.push(toolIds[0]);

    // Context grows, so cache reads grow with it. The share matters as much as
    // the total: it is what the bar under every card is measuring.
    const growth = 0.24 + 0.76 * (i / Math.max(1, s.calls - 1));
    const jitter = 0.85 + rand() * 0.3;
    const p = s.perCall;
    const message = {
      role: "assistant",
      id,
      model: s.model,
      content,
      usage: {
        input_tokens: Math.round(p.input * jitter),
        output_tokens: Math.round(p.output * jitter),
        cache_read_input_tokens: Math.round(p.cacheRead * growth * jitter),
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: Math.round(p.cacheWrite * jitter),
        },
        output_tokens_details: { thinking_tokens: Math.round((p.thinking ?? 0) * jitter) },
      },
    };
    for (let k = 0; k < 3; k++) {
      lines.push({ ...base, type: "assistant", effort: s.effort, timestamp: stamp, message });
    }

    if (failed.length) {
      lines.push({
        ...base,
        type: "user",
        timestamp: stamp,
        message: {
          role: "user",
          content: failed.map((toolId) => ({
            type: "tool_result", tool_use_id: toolId, is_error: true, content: "exit status 1",
          })),
        },
      });
    }
    lines.push({ ...base, type: "system", subtype: "turn_duration", durationMs: 38_000 + Math.round(rand() * 90_000), timestamp: stamp });
  }

  for (const q of s.queue ?? []) {
    lines.push({ ...base, type: "queue-operation", operation: "enqueue", content: q, timestamp: iso(s.endedAt) });
  }
  lines.push({ ...base, type: "last-prompt", lastPrompt: s.lastPrompt, timestamp: iso(s.endedAt) });

  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

// ---- other tools, declared rather than guessed --------------------------------
//
// Two of them on purpose: one whose rates the operator supplied in pricing.json,
// and one whose rates nobody here knows. The second is the point — its cards
// carry tokens and no dollar figure, and the charts hatch it rather than folding
// it in as zero.

const declaredSessions = [
  { src: "codex", id: "cx_9f21", model: "gpt-5.2", title: "Port the CSV importer to the new schema",
    cwd: P("work/importer"), at: NOW - 4.1 * HOUR, calls: 41, input: 9_200, output: 2_400, cached: 68_000 },
  { src: "codex", id: "cx_9f22", model: "gpt-5.2", title: "Chase the flaky upload test",
    cwd: P("work/importer"), at: NOW - 2.3 * HOUR, calls: 26, input: 7_400, output: 1_900, cached: 41_000 },
  { src: "codex", id: "cx_9f23", model: "gpt-5.2", title: "Rewrite the retry policy",
    cwd: P("work/gateway"), at: NOW - 40 * MIN, calls: 33, input: 8_100, output: 2_600, cached: 52_000 },
  { src: "gemini", id: "gm_4410", model: "gemini-3-pro", title: "Summarise the incident timeline",
    cwd: P("work/oncall"), at: NOW - 6.8 * HOUR, calls: 22, input: 24_000, output: 3_100, cached: 0 },
  { src: "gemini", id: "gm_4411", model: "gemini-3-pro", title: "Draft the postmortem sections",
    cwd: P("work/oncall"), at: NOW - 90 * MIN, calls: 18, input: 19_500, output: 2_800, cached: 0 },
];

/** Streamed the same way, so the `messageId` rule has something to do here too. */
function declared(r) {
  const rand = rng([...r.id].reduce((a, c) => a + c.charCodeAt(0), 0));
  const lines = [];
  for (let i = 0; i < r.calls; i++) {
    const jitter = 0.8 + rand() * 0.4;
    const row = {
      id: `${r.id}_m${i}`,
      model: r.model,
      created_at: iso(r.at + i * 40_000),
      title: r.title,
      cwd: r.cwd,
      usage: {
        input_tokens: Math.round(r.input * jitter),
        output_tokens: Math.round(r.output * jitter),
        cached_tokens: Math.round(r.cached * jitter),
      },
    };
    for (let k = 0; k < 3; k++) lines.push(row);
  }
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

// ---- write it out ------------------------------------------------------------

rmSync(out, { recursive: true, force: true });

for (const s of sessions) {
  const path = join(out, "claude/projects", slug(s.cwd), `${s.id}.jsonl`);
  write(path, transcript(s));
  // The archive sorts on mtime and prints it as "last active", so a tree
  // written all at once would report nine sessions that all ended this second.
  utimesSync(path, new Date(s.endedAt), new Date(s.endedAt));
}
for (const r of declaredSessions) {
  const path = join(out, r.src, "sessions", `${r.id}.jsonl`);
  write(path, declared(r));
  utimesSync(path, new Date(r.at), new Date(r.at));
}

// The other half of the registry. `claude agents --json` is what the board
// polls; `~/.claude/sessions/<pid>.json` is what the session archive reads, and
// a machine has both — without these every live session lists as ended.
for (const s of sessions.filter((x) => x.status)) {
  write(
    join(out, "claude/sessions", `${s.pid}.json`),
    `${JSON.stringify({
      pid: s.pid, sessionId: s.id, cwd: s.cwd, kind: s.kind,
      startedAt: s.startedAt, name: s.name, status: s.status,
    }, null, 2)}\n`,
  );
}

const fields = {
  model: "model", input: "usage.input_tokens", output: "usage.output_tokens",
  messageId: "id", timestamp: "created_at", title: "title", cwd: "cwd",
};
write(
  join(out, "localflow/sources.json"),
  `${JSON.stringify({
    sources: [
      { id: "codex", label: "Codex CLI", root: join(out, "codex/sessions"),
        fields: { ...fields, cacheRead: "usage.cached_tokens" } },
      { id: "gemini", label: "Gemini CLI", root: join(out, "gemini/sessions"), fields },
    ],
  }, null, 2)}\n`,
);

// Rates the operator checked themselves, with the date they checked them. Gemini
// is deliberately absent: the board has to have something it cannot price.
write(
  join(out, "localflow/pricing.json"),
  `${JSON.stringify({
    verified: new Date(NOW - 6 * 86_400_000).toISOString().slice(0, 10),
    models: { "gpt-5.2": { input: 1.25, output: 10, provider: "openai" } },
  }, null, 2)}\n`,
);

write(
  join(out, "localflow/devices.json"),
  `${JSON.stringify({
    devices: [
      { name: "spark", host: "spark.example.ts.net", cwd: "~/work" },
      { name: "nuc", host: "nuc.example.ts.net", user: "w" },
      { name: "laptop", host: "laptop.example.ts.net" },
    ],
  }, null, 2)}\n`,
);

// ---- the two shims -----------------------------------------------------------

const registry = sessions
  .filter((s) => s.status)
  .map((s) => ({
    pid: s.pid, sessionId: s.id, cwd: s.cwd, kind: s.kind,
    startedAt: s.startedAt, name: s.name, status: s.status,
  }));

write(
  join(out, "bin/claude"),
  `#!/bin/sh
# Two things only: the registry, and a headless turn.
#
# \`agents --json\` prints the rows below. \`-p ... --output-format json\` is what
# a workflow node runs, so the fixture answers it with the shape the real CLI
# returns — a session id, a cost, and some output text — which is what makes a
# workflow runnable on a machine that has no Claude Code on it. It does no work
# and says so in its own output; anything else is refused, because a shim that
# pretended to start a real session would be filming a promise.
case "$1" in
  agents)
    case "$2" in
      --json) cat <<'JSON'
${JSON.stringify(registry, null, 2)}
JSON
        exit 0 ;;
    esac ;;
  -p)
    prompt=$2
    id=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n' || echo 0000000000000000)
    cat <<JSON
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "session_id": "fixture-$id",
  "num_turns": 1,
  "duration_ms": 1200,
  "total_cost_usd": 0.0731,
  "result": "[fixture] no work was done. The prompt began: $(printf '%s' "$prompt" | tr -d '\\\\"\\n\\r\\t' | head -c 60)"
}
JSON
    exit 0 ;;
esac
echo "fixture claude: refusing '$*'" >&2
exit 64
`,
);
chmodSync(join(out, "bin/claude"), 0o755);

// The probes src/remote.ts sends, answered for three declared hosts: one
// equipped and running work, one reachable without tmux, one asleep. Those are
// the three states the devices panel has different words for, and a reel that
// only showed the happy one would be selling a feature that never fails.
write(
  join(out, "bin/ssh"),
  `#!/bin/sh
# Stands in for ssh while the reel is filmed. Answers the probes and refuses to
# start anything.
host=""
script=""
for a in "$@"; do
  case "$a" in
    -o|BatchMode=yes|ConnectTimeout=8) ;;
    *) if [ -z "$host" ]; then host="$a"; else script="$a"; fi ;;
  esac
done

case "$host" in
  *laptop*) echo "ssh: connect to host $host port 22: Host is down" >&2; exit 255 ;;
  *nuc*)
    case "$script" in *"command -v tmux"*) echo bin; exit 0 ;; esac ;;
  *spark*)
    case "$script" in
      *"command -v tmux"*) printf 'tmux\\nbin\\n'; exit 0 ;;
      *list-sessions*)
        printf 'lf-billing-audit\\t${Math.floor((NOW - 2.4 * HOUR) / 1000)}\\t0\\t1\\n'
        printf 'lf-eval-sweep\\t${Math.floor((NOW - 38 * MIN) / 1000)}\\t1\\t2\\n'
        exit 0 ;;
    esac ;;
esac
exit 0
`,
);
chmodSync(join(out, "bin/ssh"), 0o755);

write(
  join(out, "env.sh"),
  `${[
    "# Source this before serving the board for the reel.",
    `export CLAUDE_CONFIG_DIR=${join(out, "claude")}`,
    `export LOCALFLOW_CLAUDE_BIN=${join(out, "bin/claude")}`,
    `export LOCALFLOW_HOME=${join(out, "localflow")}`,
    `export LOCALFLOW_SOURCES=${join(out, "localflow/sources.json")}`,
    `export LOCALFLOW_PRICING=${join(out, "localflow/pricing.json")}`,
    `export PATH=${join(out, "bin")}:$PATH`,
  ].join("\n")}\n`,
);

console.log(`   ${sessions.length} claude sessions, ${declaredSessions.length} declared, 3 devices`);
console.log(`   ${join(out, "env.sh")}`);
