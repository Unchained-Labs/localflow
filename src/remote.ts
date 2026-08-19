/**
 * Starting and listing Claude sessions on another machine, over ssh, inside tmux.
 *
 * Why tmux and not `nohup` or `setsid`: when an ssh connection drops, the kernel
 * sends SIGHUP to the controlling terminal's whole process group, and Claude
 * Code goes with it. That is the failure this module exists to remove -- a
 * dropped train-tunnel connection should cost you a reconnect, not the session.
 * tmux keeps a server process that owns the session independently of any
 * terminal, so the hangup lands on the client and the work keeps running. It is
 * also what makes reattaching possible at all: `nohup` survives, but you can
 * never get back to it.
 *
 * Note this fixes only half of the disconnect problem. Claude Code's own Remote
 * Control has a network timeout of its own, and no amount of tmux changes that;
 * what tmux guarantees is that the *process* is still there to reconnect to.
 *
 * ## Quoting, which is the whole security story here
 *
 * `ssh host <words>` does not run <words> directly: it joins them and hands the
 * result to a shell on the far side. Everything we send is shell source code.
 * So there are exactly two kinds of value in this file and they are handled
 * differently:
 *
 *   operator values (host, user, bin, cwd, session name) come from
 *   devices.json or a validated name, and go through shq() -- single-quoted,
 *   with the one escape that single quotes need.
 *
 *   the prompt is arbitrary user text, may contain anything at all, and never
 *   appears in a command line. It is base64-encoded here, decoded into a file
 *   on the far side, and read back by the remote shell inside "$(cat ...)",
 *   whose result is not re-parsed. Base64 is [A-Za-z0-9+/=], which cannot carry
 *   a quote, a backtick, a newline or a semicolon.
 *
 * The local `ssh` invocation itself is an argv array through execFile, so no
 * local shell is involved at any point.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Device } from "./devices.js";

const run = promisify(execFile);

/** tmux session names we are willing to create or address. */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Sessions localflow started carry this prefix, so we never list or kill someone else's work. */
export const SESSION_PREFIX = "lf-";

export interface RemoteSession {
  /** Full tmux session name, including the prefix. */
  name: string;
  /** Seconds since the session was created, as tmux reports it. */
  createdAt: number | null;
  attached: boolean;
  windows: number;
}

export interface RemoteResult<T> {
  ok: boolean;
  value?: T;
  /** One line a human can act on. */
  error?: string;
}

/**
 * Single-quote a value for a POSIX shell.
 *
 * The only character that cannot appear inside single quotes is a single quote,
 * which is closed, escaped and reopened. Everything else -- spaces, $, `, ;, \n
 * -- is literal.
 */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The argv prefix for reaching a device. Never includes a password option: see below. */
export function sshArgs(device: Device): string[] {
  return [
    // Fail instead of prompting. This is what makes "localflow stores no
    // credentials" true rather than aspirational: if the operator's ssh cannot
    // authenticate on its own, we surface that and stop, and there is nowhere
    // in the system for a password to be typed or kept.
    "-o",
    "BatchMode=yes",
    // A device that is off should report as off in a couple of seconds, not
    // hold an HTTP handler open for the TCP default.
    "-o",
    "ConnectTimeout=8",
    device.user ? `${device.user}@${device.host}` : device.host,
  ];
}

async function ssh(device: Device, script: string, timeoutMs = 20_000): Promise<RemoteResult<string>> {
  try {
    const { stdout } = await run("ssh", [...sshArgs(device), script], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, value: stdout };
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: unknown };
    const detail = (err.stderr || err.message || "ssh failed").trim().split("\n")[0];
    return { ok: false, error: detail };
  }
}

/** Is tmux even installed over there? Distinguishes "no sessions" from "cannot tell". */
export async function probeDevice(device: Device): Promise<RemoteResult<{ tmux: boolean; bin: boolean }>> {
  const bin = device.bin ?? "claude";
  const res = await ssh(
    device,
    `command -v tmux >/dev/null && echo tmux; command -v ${shq(bin)} >/dev/null && echo bin`,
  );
  if (!res.ok) return { ok: false, error: res.error };
  const out = res.value ?? "";
  return { ok: true, value: { tmux: /^tmux$/m.test(out), bin: /^bin$/m.test(out) } };
}

export async function listSessions(device: Device): Promise<RemoteResult<RemoteSession[]>> {
  // `|| true` so a host with no sessions at all is success-with-nothing rather
  // than tmux's exit 1, which would otherwise read to the UI as a broken device.
  const res = await ssh(
    device,
    "tmux list-sessions -F '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}' 2>/dev/null || true",
  );
  if (!res.ok) return { ok: false, error: res.error };

  const sessions: RemoteSession[] = [];
  for (const line of (res.value ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [name, created, attached, windows] = line.split("\t");
    // Only ours. tmux is a shared tool and the operator's own sessions are none
    // of this board's business -- listing them would invite a kill button
    // pointed at something localflow never started.
    if (!name?.startsWith(SESSION_PREFIX)) continue;
    const createdAt = Number(created);
    sessions.push({
      name,
      createdAt: Number.isFinite(createdAt) ? createdAt * 1000 : null,
      attached: attached === "1",
      windows: Number(windows) || 1,
    });
  }
  return { ok: true, value: sessions };
}

export interface StartOptions {
  /** Appended to SESSION_PREFIX. Validated; callers may pass anything. */
  name: string;
  /** Arbitrary user text. Never reaches a command line -- see the module comment. */
  prompt: string;
  /** Overrides the device's default working directory. */
  cwd?: string;
}

/**
 * The remote shell source for starting one session.
 *
 * Exported so it can be run against a real shell in the tests. Asserting on the
 * string alone would happily pass a subtly wrong escape; the only convincing
 * check is to execute it and see what the prompt file actually contains.
 *
 * Read it as three statements, in order:
 *   1. materialise the prompt on the far side from base64
 *   2. refuse if that session name is taken, rather than silently adopting
 *      somebody else's session and reporting success
 *   3. start it detached
 *
 * `$(cat ...)` inside double quotes hands the file's bytes to the binary as one
 * argument; the shell does not re-parse the substitution's result, which is what
 * makes an arbitrary prompt safe here.
 */
export function buildStartScript(device: Device, session: string, prompt: string, cwd: string): string {
  const bin = device.bin ?? "claude";
  const b64 = Buffer.from(prompt, "utf8").toString("base64");
  const promptFile = `$HOME/.localflow/prompts/${session}.txt`;
  return [
    `mkdir -p "$HOME/.localflow/prompts"`,
    `printf %s ${shq(b64)} | base64 -d > "${promptFile}"`,
    `if tmux has-session -t ${shq(session)} 2>/dev/null; then echo "EXISTS" >&2; exit 3; fi`,
    `tmux new-session -d -s ${shq(session)} -c ${shq(cwd)} ` +
      `${shq(`${bin} -p "$(cat ${promptFile})"`)}`,
  ].join(" && ");
}

export async function startSession(
  device: Device,
  opts: StartOptions,
): Promise<RemoteResult<{ session: string; attach: string }>> {
  const session = `${SESSION_PREFIX}${opts.name}`;
  if (!SESSION_RE.test(session)) {
    return { ok: false, error: `${opts.name}: name must be letters, digits, dot, dash or underscore` };
  }
  if (!opts.prompt.trim()) return { ok: false, error: "a prompt is required" };

  const cwd = opts.cwd ?? device.cwd ?? ".";
  const script = buildStartScript(device, session, opts.prompt, cwd);

  const res = await ssh(device, script, 30_000);
  if (!res.ok) {
    if ((res.error ?? "").includes("EXISTS")) {
      return { ok: false, error: `${session} is already running on ${device.name}` };
    }
    return { ok: false, error: res.error };
  }

  return {
    ok: true,
    value: {
      session,
      // What a human types to look at it. localflow deliberately does not
      // proxy an interactive terminal: attaching is a decision, and a board
      // that quietly holds a PTY open to another machine is a bigger promise
      // than this feature is making.
      attach: `ssh -t ${sshArgs(device).slice(-1)[0]} tmux attach -t ${session}`,
    },
  };
}

export async function killSession(device: Device, name: string): Promise<RemoteResult<null>> {
  if (!SESSION_RE.test(name) || !name.startsWith(SESSION_PREFIX)) {
    // Refusing anything without our prefix is what keeps this from being a
    // remote `tmux kill-session` for the whole machine.
    return { ok: false, error: `${name} is not a localflow session` };
  }
  const res = await ssh(device, `tmux kill-session -t ${shq(name)}`);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, value: null };
}
