import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonRecord {
  readonly version: 1;
  readonly hostname: string;
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly scopeDir: string | null;
}

// ---------------------------------------------------------------------------
// Host normalization
// ---------------------------------------------------------------------------

const LOCAL_HOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const canonicalDaemonHost = (hostname: string): string => {
  const normalized = hostname.trim().toLowerCase();
  return LOCAL_HOST_ALIASES.has(normalized) ? "localhost" : normalized;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const resolveDaemonDataDir = (): string => process.env.EXECUTOR_DATA_DIR ?? join(homedir(), ".executor");

const sanitizeHostForPath = (hostname: string): string => hostname.replaceAll(/[^a-z0-9.-]+/gi, "_");

const daemonRecordPath = (input: { hostname: string; port: number }): string => {
  const host = sanitizeHostForPath(canonicalDaemonHost(input.hostname));
  return join(resolveDaemonDataDir(), `daemon-${host}-${input.port}.json`);
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const writeDaemonRecord = async (input: {
  hostname: string;
  port: number;
  pid: number;
  scopeDir: string | null;
}): Promise<void> => {
  const path = daemonRecordPath({ hostname: input.hostname, port: input.port });
  const dir = resolveDaemonDataDir();
  await mkdir(dir, { recursive: true });

  const payload: DaemonRecord = {
    version: 1,
    hostname: canonicalDaemonHost(input.hostname),
    port: input.port,
    pid: input.pid,
    startedAt: new Date().toISOString(),
    scopeDir: input.scopeDir,
  };

  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const parseRecord = (raw: string): DaemonRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    return null;
  }

  const r = parsed as Record<string, unknown>;
  if (
    typeof r.hostname !== "string" ||
    typeof r.port !== "number" ||
    typeof r.pid !== "number" ||
    typeof r.startedAt !== "string" ||
    !(typeof r.scopeDir === "string" || r.scopeDir === null)
  ) {
    return null;
  }

  return {
    version: 1,
    hostname: canonicalDaemonHost(r.hostname),
    port: r.port,
    pid: r.pid,
    startedAt: r.startedAt,
    scopeDir: r.scopeDir,
  };
};

export const readDaemonRecord = async (input: {
  hostname: string;
  port: number;
}): Promise<DaemonRecord | null> => {
  const path = daemonRecordPath({ hostname: input.hostname, port: input.port });
  try {
    const raw = await readFile(path, "utf8");
    return parseRecord(raw);
  } catch {
    return null;
  }
};

export const removeDaemonRecord = async (input: { hostname: string; port: number }): Promise<void> => {
  const path = daemonRecordPath({ hostname: input.hostname, port: input.port });
  await rm(path, { force: true });
};

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const terminatePid = (pid: number): void => {
  process.kill(pid, "SIGTERM");
};
