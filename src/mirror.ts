/**
 * Watching the Claude Code sessions on another machine.
 *
 * `remote.ts` can *start* work on a declared device. This module reads it back,
 * so a device is not just somewhere you fire things off into -- its sessions
 * land on the same board, in the same lanes, with the same token counts and the
 * same price, as the ones on the laptop in front of you.
 *
 * ## Mirror, do not reimplement
 *
 * The obvious way to do this is to run a summariser on the far side and ship
 * back a small JSON blob. It is also the wrong way: the transcript rules in
 * `transcript.ts` were derived by measuring a real transcript, they are the
 * most subtle thing in this repo, and a second copy of them written in awk
 * would start drifting the day after it was written. A cost that is right for
 * local sessions and quietly wrong for remote ones is worse than no remote
 * support at all.
 *
 * So instead the transcript itself is mirrored, incrementally, into
 * `~/.localflow/mirror/<device>/<sessionId>.jsonl`, and then parsed by exactly
 * the same `advance()` every local session goes through. There is one parser,
 * and remote cards are not a second-class kind of card.
 *
 * That does mean **another machine's transcripts get copied onto this disk** --
 * prompts, file contents, whatever was pasted into a session. That is a real
 * consequence of asking for this feature rather than an implementation detail,
 * so `--watch-remote` is its own flag, the mirror directory is created 0700,
 * and `/api/health` reports where it is.
 *
 * ## Two round trips per device per poll
 *
 * ssh is expensive in a way that a local `readSync` is not, so the shape of the
 * conversation matters more than anything else here:
 *
 *   1. **manifest** -- one call returning the registry and a stat of every
 *      transcript on the machine. Small, and fixed size regardless of how much
 *      those transcripts contain.
 *   2. **fetch** -- one call returning the bytes appended to the files that
 *      actually grew, framed so several files ride one stream. Skipped entirely
 *      when nothing changed, which is the common case.
 *
 * Not "one ssh per session": a machine with 30 sessions would spend its whole
 * poll interval in connection setup. Connections are also multiplexed
 * (`ControlMaster`), so steady-state polls reuse one handshake.
 *
 * ## Quoting
 *
 * The rules from `remote.ts` hold unchanged: operator values are single-quoted
 * through `shq()`, the local `ssh` is an argv array through execFile so no local
 * shell is ever involved, and nothing a request body says can name a host.
 *
 * Values that come back *from* the far side -- session ids, transcript paths --
 * are the new thing, because they are the one input here we did not write. They
 * are validated against a strict pattern and confined to the root we asked
 * about before they are ever quoted into the next script. A host that answers
 * our manifest with a creative path gets its answer dropped, not run.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { TranscriptCache, toTask } from "./claude.js";
import type { Device } from "./devices.js";
import { shq } from "./remote.js";
import type { LiveSession, Task } from "./types.js";

const run = promisify(execFile);

/** Session ids we are willing to turn into a filename or a shell word. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Paths we are willing to read back.
 *
 * Only whitespace is excluded here, because the real containment check is
 * `startsWith(root + "/projects/")` against the root the device itself
 * resolved -- see `==LF-ROOT==` below. An earlier version spelled out an
 * allowed character set instead, which silently dropped every transcript
 * belonging to a user whose home directory had a `+` in it. A pattern that
 * quietly watches nothing is worse than one that watches the wrong thing
 * loudly.
 */
const PATH_RE = /^\S+\.jsonl$/;

/** Frames in the fetch stream. Chosen to be impossible in a slugged path. */
const FRAME = "==LF ";

/**
 * How much of a transcript to pull the first time we see it.
 *
 * A long-running session's transcript reaches tens of megabytes, and the first
 * sync of a fleet should not be a surprise transfer. Past this, the mirror
 * starts from the tail and the card says so -- see `partial` below, which is
 * the difference between a cost that is a total and a cost that is a floor.
 */
export const DEFAULT_FIRST_PULL = 8 << 20;

/**
 * Ceiling on what one fetch call may carry.
 *
 * The whole stream is buffered before it is parsed, so a first sync of thirty
 * sessions on one machine would otherwise be a single multi-hundred-megabyte
 * allocation. Files past the ceiling are not dropped -- they are simply not
 * asked for until the next poll, and the poll says how many are still to come.
 */
export const DEFAULT_MAX_PER_POLL = 48 << 20;

export interface MirrorOptions {
  /** Where mirrored transcripts live. */
  root?: string;
  /** Bytes pulled on a first sync. */
  firstPull?: number;
  /** Ceiling on one fetch call. The rest waits for the next poll. */
  maxPerPoll?: number;
  /** Ended sessions to keep per device. */
  history?: number;
  asOf?: string;
  /** The ssh binary. Overridable so the tests can run the generated script for real. */
  sshBin?: string;
}

export function mirrorRoot(opts: MirrorOptions = {}): string {
  return (
    opts.root ??
    join(process.env.LOCALFLOW_HOME ?? join(homedir(), ".localflow"), "mirror")
  );
}

function controlDir(): string {
  return join(process.env.LOCALFLOW_HOME ?? join(homedir(), ".localflow"), "ssh");
}

/**
 * ssh argv for a read-only poll.
 *
 * `BatchMode=yes` for the same reason as everywhere else: if the operator's ssh
 * cannot authenticate on its own we stop and say so, and there is nowhere in
 * this program for a password to live.
 *
 * The multiplexing options are what make a poll interval realistic. Without
 * them every poll pays a fresh TCP and key exchange per device; with them the
 * first poll pays it once and the rest ride the same connection. `auto` falls
 * back to an ordinary connection if the socket cannot be made, so a machine
 * where this does not work is slower rather than broken.
 */
export function watchArgs(device: Device): string[] {
  const dir = controlDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* a control socket we cannot place is a slower poll, not a failed one */
  }
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(dir, "%C")}`,
    "-o", "ControlPersist=60",
    device.user ? `${device.user}@${device.host}` : device.host,
  ];
}

async function ssh(
  device: Device,
  script: string,
  opts: MirrorOptions,
  timeoutMs: number,
): Promise<{ ok: true; out: Buffer } | { ok: false; error: string }> {
  const bin = opts.sshBin ?? process.env.LOCALFLOW_SSH_BIN ?? "ssh";
  try {
    const { stdout } = await run(bin, [...watchArgs(device), script], {
      timeout: timeoutMs,
      maxBuffer: 256 << 20,
      encoding: "buffer",
    });
    return { ok: true, out: stdout as unknown as Buffer };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const raw = err.stderr ? err.stderr.toString() : (err.message ?? "ssh failed");
    return { ok: false, error: raw.trim().split("\n")[0] || "ssh failed" };
  }
}

/**
 * The remote root holding `projects/<slug>/<id>.jsonl`.
 *
 * `$HOME` is left for the far side to expand rather than resolved here: we do
 * not know the remote user's home directory and guessing `/home/<user>` is how
 * you end up silently watching nothing on a Mac.
 */
function remoteHome(device: Device): string {
  return device.home ? shq(device.home) : `"$HOME/.claude"`;
}

/**
 * One call: the registry, then a stat of every transcript.
 *
 * `stat` is the portability hazard -- GNU takes `-c` with `%s %Y %n`, BSD and
 * macOS take `-f` with `%z %m %N` -- so the format is chosen by trying the GNU
 * one against `.` first. `find -printf` would have been shorter and does not
 * exist on macOS at all.
 *
 * The registry call is allowed to fail without failing the script: a machine
 * where `claude` is not on PATH still has transcripts worth reading, and the
 * caller can tell the two apart because the registry section is empty while the
 * file section is not.
 */
export function buildManifestScript(device: Device): string {
  const bin = shq(device.bin ?? "claude");
  const root = remoteHome(device);
  const TAB = "\t";
  return [
    // Printed by the far side rather than assumed here: `$HOME` is expanded
    // over there, and this is what every path is then checked against.
    `printf '==LF-ROOT==\\n'`,
    `printf '%s\\n' ${root}`,
    `printf '==LF-REGISTRY==\\n'`,
    `command -v ${bin} >/dev/null 2>&1 && ${bin} agents --json 2>/dev/null || true`,
    `printf '\\n==LF-FILES==\\n'`,
    `if stat -c %Y . >/dev/null 2>&1; then LFF='-c%s${TAB}%Y${TAB}%n'; else LFF='-f%z${TAB}%m${TAB}%N'; fi`,
    `find ${root}/projects -type f -name '*.jsonl' -print0 2>/dev/null | xargs -0 stat "$LFF" 2>/dev/null || true`,
  ].join("\n");
}

export interface RemoteFile {
  id: string;
  path: string;
  size: number;
  mtime: number;
}

export interface Manifest {
  sessions: LiveSession[];
  files: RemoteFile[];
  /** Set when `claude agents --json` could not be run or did not parse. */
  registryError?: string;
}

/**
 * Split the manifest output.
 *
 * Every file the far side named is checked against the root we asked about and
 * the pattern above before it goes anywhere near the next script. Dropping a
 * row is deliberately silent for `.jsonl` files outside the projects tree --
 * they are not ours to read -- but a device whose every row is dropped shows up
 * as a device with no sessions, which the caller reports.
 */
export function parseManifest(text: string, device: Device): Manifest {
  const rootAt = text.indexOf("==LF-ROOT==");
  const regAt = text.indexOf("==LF-REGISTRY==");
  const filesAt = text.indexOf("==LF-FILES==");
  if (rootAt < 0 || regAt < 0 || filesAt < 0) {
    return { sessions: [], files: [], registryError: "the device did not answer in the expected form" };
  }
  const root = text.slice(rootAt + "==LF-ROOT==".length, regAt).trim();
  const prefix = `${root.replace(/\/$/, "")}/projects/`;
  const regText = text.slice(regAt + "==LF-REGISTRY==".length, filesAt).trim();
  const fileText = text.slice(filesAt + "==LF-FILES==".length);

  let sessions: LiveSession[] = [];
  let registryError: string | undefined;
  if (!regText) {
    registryError = `\`${device.bin ?? "claude"} agents --json\` produced nothing — is Claude Code installed there?`;
  } else {
    try {
      const parsed: unknown = JSON.parse(regText);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      sessions = parsed.filter(
        (v): v is LiveSession =>
          !!v && typeof (v as LiveSession).sessionId === "string" && typeof (v as LiveSession).cwd === "string",
      );
    } catch (e) {
      registryError = `the session registry did not parse: ${(e as Error).message}`;
    }
  }

  const files: RemoteFile[] = [];
  for (const line of fileText.split("\n")) {
    if (!line.trim()) continue;
    const [sizeStr, mtimeStr, path] = line.split("\t");
    if (!path || !PATH_RE.test(path)) continue;
    // The one check that matters: inside the tree we asked about. A device
    // answering with `/etc/shadow.jsonl` gets its answer dropped, not run.
    if (!root || !path.startsWith(prefix)) continue;
    if (path.includes("/../")) continue;
    const id = basename(path, ".jsonl");
    if (!ID_RE.test(id)) continue;
    const size = Number(sizeStr);
    const mtime = Number(mtimeStr);
    if (!Number.isFinite(size)) continue;
    files.push({ id, path, size, mtime: Number.isFinite(mtime) ? mtime * 1000 : 0 });
  }
  return { sessions, files, registryError };
}

/** One file's worth of "send me what I do not have yet". */
export interface Want {
  file: RemoteFile;
  /** Byte offset to resume from. */
  from: number;
}

/**
 * The fetch script: for each wanted file, a framed chunk.
 *
 * The size is re-read on the far side rather than trusted from the manifest,
 * because a live session appends between the two calls; the header carries the
 * count actually being sent so the reader never has to guess where one file
 * ends and the next begins. `tail -c +N | head -c C` rather than `dd bs=1`,
 * which would be one syscall per byte.
 */
export function buildFetchScript(wants: Want[]): string {
  const parts: string[] = [];
  for (const w of wants) {
    const f = shq(w.file.path);
    parts.push(
      [
        `LFO=${w.from}`,
        `LFN=$(wc -c < ${f} 2>/dev/null || echo 0)`,
        `if [ "$LFN" -gt "$LFO" ]; then`,
        `  LFC=$((LFN - LFO))`,
        `  printf '${FRAME}%s %s\\n' ${shq(w.file.id)} "$LFC"`,
        `  tail -c +$((LFO + 1)) ${f} 2>/dev/null | head -c "$LFC"`,
        `fi`,
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

export interface Chunk {
  id: string;
  bytes: Buffer;
  /** True when the stream ended before the header's byte count was delivered. */
  short?: boolean;
}

/**
 * Read the framed stream back.
 *
 * Deterministic by construction: a header names a count, exactly that many
 * bytes follow, and the next header begins immediately after. Transcript
 * content is never scanned for framing, so a session that pastes this module's
 * own source into a prompt cannot desynchronise the reader.
 */
export function parseFrames(buf: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.toString("utf8", pos, nl);
    if (!header.startsWith(FRAME)) break;
    const [id, countStr] = header.slice(FRAME.length).split(" ");
    const count = Number(countStr);
    if (!id || !ID_RE.test(id) || !Number.isFinite(count) || count < 0) break;
    const start = nl + 1;
    const end = Math.min(start + count, buf.length);
    chunks.push({ id, bytes: buf.subarray(start, end), short: end - start < count ? true : undefined });
    if (end - start < count) break;
    pos = end;
  }
  return chunks;
}

export interface DevicePoll {
  device: string;
  host: string;
  tasks: Task[];
  degraded: { id: string; reason: string }[];
  reachable: boolean;
  error: string | null;
  /** When this device last answered. Null until it ever has. */
  syncedAt: number | null;
  /** Set while the cards below are the last known state of a device we cannot currently reach. */
  staleSince: number | null;
  /** Bytes pulled on the most recent successful poll. */
  pulled: number;
}

/**
 * One declared device, polled and mirrored.
 *
 * Holds the parse state across polls exactly like the local board does, so a
 * mirrored transcript is read once and then only appended to. The instance is
 * per device and lives as long as the server.
 */
export class DeviceWatcher {
  private readonly cache = new TranscriptCache();
  /** Sessions truncated on their first pull, whose totals are floors. */
  private readonly partial = new Set<string>();
  private lastTasks: Task[] = [];
  private syncedAt: number | null = null;
  private staleSince: number | null = null;

  constructor(
    readonly device: Device,
    private readonly opts: MirrorOptions = {},
  ) {}

  private made = false;

  private dir(): string {
    const d = join(mirrorRoot(this.opts), this.device.name);
    if (!this.made) {
      // 0700 because this directory holds another machine's prompts.
      mkdirSync(d, { recursive: true, mode: 0o700 });
      this.made = true;
    }
    return d;
  }

  private mirrorPath(id: string): string {
    return join(this.dir(), `${id}.jsonl`);
  }

  /** Bytes of a session we already hold. Missing file means start from nothing. */
  private have(id: string): number {
    try {
      return statSync(this.mirrorPath(id)).size;
    } catch {
      return 0;
    }
  }

  async poll(): Promise<DevicePoll> {
    const base = { device: this.device.name, host: this.device.host };

    const manRes = await ssh(this.device, buildManifestScript(this.device), this.opts, 25_000);
    if (!manRes.ok) {
      // The cards we already have are not deleted. A laptop that closed its lid
      // did not stop having had those sessions, and a board that empties a lane
      // on a dropped connection teaches you to distrust the lane. They are
      // marked stale instead, with the time they were last true.
      if (this.staleSince === null) this.staleSince = this.syncedAt;
      const stale = this.lastTasks.map((t) => ({ ...t, staleSince: this.staleSince ?? undefined }));
      return {
        ...base,
        tasks: stale,
        degraded: [
          {
            id: `device:${this.device.name}`,
            reason: stale.length
              ? `${this.device.name} is unreachable (${manRes.error}); ${stale.length} card(s) are the last known state`
              : `${this.device.name} is unreachable: ${manRes.error}`,
          },
        ],
        reachable: false,
        error: manRes.error,
        syncedAt: this.syncedAt,
        staleSince: this.staleSince,
        pulled: 0,
      };
    }

    const manifest = parseManifest(manRes.out.toString("utf8"), this.device);
    const degraded: { id: string; reason: string }[] = [];
    if (manifest.registryError) {
      degraded.push({ id: `device:${this.device.name}`, reason: `${this.device.name}: ${manifest.registryError}` });
    }

    const byId = new Map(manifest.files.map((f) => [f.id, f]));
    const liveIds = new Set(manifest.sessions.map((s) => s.sessionId));

    // Live sessions first, then the most recently touched ended ones, capped the
    // same way the local board caps its history.
    const wantIds: string[] = [...liveIds].filter((id) => byId.has(id));
    const historyLimit = this.opts.history ?? 10;
    if (historyLimit > 0) {
      const ended = manifest.files
        .filter((f) => !liveIds.has(f.id))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, historyLimit);
      wantIds.push(...ended.map((f) => f.id));
    }

    const wants: Want[] = [];
    const firstPull = this.opts.firstPull ?? DEFAULT_FIRST_PULL;
    for (const id of wantIds) {
      const file = byId.get(id)!;
      let have = this.have(id);
      if (have > file.size) {
        // The far side rotated or replaced the file. Resuming into the middle of
        // a different file would fold one session's tokens into another's.
        try {
          truncateSync(this.mirrorPath(id), 0);
        } catch {
          writeFileSync(this.mirrorPath(id), "");
        }
        this.cache.forget(this.qualify(id));
        this.partial.delete(id);
        have = 0;
      }
      if (have === 0 && file.size > firstPull) {
        wants.push({ file, from: file.size - firstPull });
        this.partial.add(id);
        continue;
      }
      if (file.size > have) wants.push({ file, from: have });
    }

    // Trim to the per-poll ceiling, newest first so the board fills in with the
    // sessions someone is most likely watching.
    const ceiling = this.opts.maxPerPoll ?? DEFAULT_MAX_PER_POLL;
    let deferred = 0;
    if (wants.length) {
      const kept: Want[] = [];
      let budget = ceiling;
      for (const w of wants) {
        const need = w.file.size - w.from;
        // Always take the first, even if it alone exceeds the ceiling: skipping
        // it would mean never syncing a session bigger than the budget at all.
        if (kept.length && need > budget) {
          deferred++;
          continue;
        }
        budget -= need;
        kept.push(w);
      }
      wants.length = 0;
      wants.push(...kept);
    }
    if (deferred) {
      // Named, not silent. A cap nobody mentions reads as "everything is here".
      degraded.push({
        id: `device:${this.device.name}`,
        reason: `${this.device.name}: ${deferred} transcript(s) still syncing — they arrive on a later poll`,
      });
    }

    let pulled = 0;
    if (wants.length) {
      const fetched = await ssh(this.device, buildFetchScript(wants), this.opts, 120_000);
      if (!fetched.ok) {
        degraded.push({
          id: `device:${this.device.name}`,
          reason: `${this.device.name}: could not read transcripts (${fetched.error}); cards may be behind`,
        });
      } else {
        for (const chunk of parseFrames(fetched.out)) {
          appendFileSync(this.mirrorPath(chunk.id), chunk.bytes);
          pulled += chunk.bytes.length;
          if (chunk.short) {
            degraded.push({
              id: this.qualify(chunk.id),
              reason: "the transfer ended early; this card is behind the machine it came from",
            });
          }
        }
      }
    }

    const tasks: Task[] = [];
    const seen = new Set<string>();
    for (const id of wantIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const qualified = this.qualify(id);
      const path = this.mirrorPath(id);
      if (!existsSync(path)) continue;
      const state = this.cache.refresh(qualified, path);
      const session = manifest.sessions.find((s) => s.sessionId === id);
      // Built with the bare id and re-keyed after, so the fallbacks inside
      // toTask -- a nameless ended session is called by the first eight
      // characters of its id -- name the session rather than naming this
      // module's prefixing scheme. `spark:d4` was not a session id anywhere.
      const task = toTask(id, session, state, path, this.opts);
      task.id = qualified;
      task.device = this.device.name;
      task.remoteId = id;
      if (this.partial.has(id)) {
        task.partial = true;
        degraded.push({
          id: qualified,
          reason:
            `only the last ${Math.round((this.opts.firstPull ?? DEFAULT_FIRST_PULL) / (1 << 20))}MB of this ` +
            "transcript was pulled, so its tokens and cost are a floor, not a total",
        });
      }
      if (state?.unreadableLines) {
        degraded.push({
          id: qualified,
          reason: `${state.unreadableLines} transcript line(s) would not parse and were skipped`,
        });
      }
      tasks.push(task);
    }

    // A live session whose transcript we never found is still running over
    // there, and dropping it would under-report the fleet.
    for (const s of manifest.sessions) {
      if (byId.has(s.sessionId)) continue;
      const qualified = this.qualify(s.sessionId);
      const task = toTask(s.sessionId, s, undefined, undefined, this.opts);
      task.id = qualified;
      task.device = this.device.name;
      task.remoteId = s.sessionId;
      tasks.push(task);
      degraded.push({
        id: qualified,
        reason: "no transcript found on the device — the card shows registry data only, with no tokens or cost",
      });
    }

    this.lastTasks = tasks;
    this.syncedAt = Date.now();
    this.staleSince = null;
    return {
      ...base,
      tasks,
      degraded,
      reachable: true,
      error: null,
      syncedAt: this.syncedAt,
      staleSince: null,
      pulled,
    };
  }

  /**
   * Two machines can hold the same session id -- a cloned home directory is
   * enough -- and a board keyed on the bare id would merge their cards and add
   * their costs together. The device name is part of the identity.
   */
  private qualify(id: string): string {
    return `${this.device.name}:${id}`;
  }
}

/**
 * Every device the operator asked to watch, polled concurrently.
 *
 * Concurrent because one asleep machine holding a `ConnectTimeout` must not
 * delay the ones that are awake, and because the whole point of a fleet view is
 * that it does not get slower per machine.
 */
export class Fleet {
  private readonly watchers = new Map<string, DeviceWatcher>();

  constructor(private readonly opts: MirrorOptions = {}) {}

  /** Reconcile with the current devices.json, keeping state for devices that stayed. */
  sync(devices: Device[]): void {
    const wanted = new Set<string>();
    for (const d of devices) {
      if (d.monitor === false) continue;
      wanted.add(d.name);
      const existing = this.watchers.get(d.name);
      // A device whose host or user was edited is a different machine; its
      // mirrored state should not be inherited by the new one.
      if (
        !existing ||
        existing.device.host !== d.host ||
        existing.device.user !== d.user ||
        existing.device.home !== d.home ||
        existing.device.bin !== d.bin
      ) {
        this.watchers.set(d.name, new DeviceWatcher(d, this.opts));
      }
    }
    for (const name of [...this.watchers.keys()]) {
      if (!wanted.has(name)) this.watchers.delete(name);
    }
  }

  async poll(): Promise<DevicePoll[]> {
    return await Promise.all([...this.watchers.values()].map((w) => w.poll()));
  }

  get size(): number {
    return this.watchers.size;
  }
}
