/**
 * The machines this board is allowed to reach, and nothing else.
 *
 * A dashboard that can start a process on another computer is a different kind
 * of program from one that reads files, so the rules here are deliberately
 * narrow:
 *
 *   - A device must be *declared*, in ~/.localflow/devices.json. There is no
 *     "host" parameter anywhere in the HTTP surface. Callers name a device;
 *     the host it resolves to comes from this file. A board that accepts a
 *     hostname from a request body is an SSH client with a web front end, and
 *     one reflected request away from being someone else's.
 *
 *   - No credentials live here. Authentication is whatever the operator's SSH
 *     already does -- agent, key, certificate. If a password would be needed,
 *     the connection fails and says so, because the alternative is this file
 *     growing a `password` field and becoming the most sensitive thing on the
 *     box. loadDevices() actively rejects a device that carries one, rather
 *     than ignoring the field, so a well-meaning edit fails loudly instead of
 *     silently writing a secret to disk.
 *
 * Absence is not failure, the same way it is not for the agent adapters: a
 * machine with no devices.json is a machine that does not use this feature and
 * should see nothing about it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Device {
  /** Stable handle used by the API and shown in the UI. */
  name: string;
  /** Where ssh connects. May be a tailnet FQDN, an alias from ~/.ssh/config, anything ssh takes. */
  host: string;
  /** Remote user. Omitted means "whatever ssh would pick", i.e. ~/.ssh/config. */
  user?: string;
  /** The Claude binary on that machine, when it is not simply `claude` on PATH. */
  bin?: string;
  /** Working directory for sessions started there. */
  cwd?: string;
  /** The Claude Code state directory there, when it is not `$HOME/.claude`. */
  home?: string;
  /**
   * Set false to keep a device out of the board while still being able to start
   * work on it. Monitoring copies that machine's transcripts onto this disk, so
   * a device you spawn into but do not want mirrored is a real thing to want.
   */
  monitor?: boolean;
}

export interface DevicesFile {
  devices?: Device[];
}

/**
 * Fields that must never appear on a device. These are not "unsupported" -- they
 * are the shapes a secret arrives in, and the file is plain JSON in a home
 * directory. Naming them explicitly means a device that carries one is an error
 * the operator sees, not a value we quietly drop and forget to mention.
 */
const SECRET_FIELDS = ["password", "passphrase", "key", "privateKey", "identity", "token"];

/** A device name has to survive being a tmux session name and a log line. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function devicesPath(): string {
  return join(process.env.LOCALFLOW_HOME ?? join(homedir(), ".localflow"), "devices.json");
}

export interface LoadedDevices {
  devices: Device[];
  /** One line naming what was wrong, when something was. */
  error?: string;
}

export function loadDevices(path = devicesPath()): LoadedDevices {
  if (!existsSync(path)) return { devices: [] };

  let parsed: DevicesFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as DevicesFile;
  } catch (e) {
    return { devices: [], error: `${path} is not valid JSON: ${(e as Error).message}` };
  }

  const list = Array.isArray(parsed?.devices) ? parsed.devices : [];
  const good: Device[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const d of list) {
    if (!d || typeof d.name !== "string" || typeof d.host !== "string") {
      problems.push("a device with no name or host");
      continue;
    }
    if (!NAME_RE.test(d.name)) {
      problems.push(`${d.name}: name must be letters, digits, dot, dash or underscore`);
      continue;
    }
    const carried = SECRET_FIELDS.filter((f) => (d as unknown as Record<string, unknown>)[f] != null);
    if (carried.length) {
      // Refusing the whole device, not just the field. Loading it without the
      // credential would "work" against a key-based host and quietly leave the
      // secret sitting in the file for the next person to find.
      problems.push(
        `${d.name}: remove ${carried.join(", ")} -- localflow never stores credentials, ` +
          "it uses your existing ssh auth",
      );
      continue;
    }
    if (seen.has(d.name)) {
      problems.push(`${d.name}: declared twice`);
      continue;
    }
    seen.add(d.name);
    good.push({
      name: d.name,
      host: d.host,
      user: d.user,
      bin: d.bin,
      cwd: d.cwd,
      home: d.home,
      monitor: d.monitor,
    });
  }

  return {
    devices: good,
    error: problems.length ? `${path}: ${problems.join("; ")}` : undefined,
  };
}

/**
 * Resolve a caller-supplied name against the registry.
 *
 * This is the only way a host gets into an ssh argv. Returning undefined for an
 * unknown name is the entire access-control model, so it must stay a lookup and
 * never become a fallback that treats the name as a hostname.
 */
export function findDevice(devices: Device[], name: unknown): Device | undefined {
  if (typeof name !== "string" || !name) return undefined;
  return devices.find((d) => d.name === name);
}
