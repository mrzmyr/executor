import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedDaemonBaseUrl {
  readonly hostname: string;
  readonly port: number;
}

export interface DaemonSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Base URL parsing
// ---------------------------------------------------------------------------

export const parseDaemonBaseUrl = (baseUrl: string, defaultPort: number): ParsedDaemonBaseUrl => {
  const parsed = new URL(baseUrl);

  if (parsed.protocol !== "http:") {
    throw new Error(`Only http:// base URLs are supported for daemon auto-start: ${baseUrl}`);
  }

  const port = Number(parsed.port) || defaultPort;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid daemon port in base URL: ${baseUrl}`);
  }

  return {
    hostname: parsed.hostname || "localhost",
    port,
  };
};

// ---------------------------------------------------------------------------
// Local-host checks
// ---------------------------------------------------------------------------

const LOCAL_DAEMON_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export const canAutoStartLocalDaemonForHost = (hostname: string): boolean =>
  LOCAL_DAEMON_HOSTNAMES.has(hostname.toLowerCase());

// ---------------------------------------------------------------------------
// Process spec
// ---------------------------------------------------------------------------

export const buildDaemonSpawnSpec = (input: {
  readonly port: number;
  readonly hostname: string;
  readonly isDevMode: boolean;
  readonly scriptPath: string | undefined;
  readonly executablePath: string;
}): DaemonSpawnSpec => {
  const daemonArgs = ["daemon", "run", "--port", String(input.port), "--hostname", input.hostname];

  if (input.isDevMode) {
    if (!input.scriptPath) {
      throw new Error("Cannot auto-start daemon in dev mode without a CLI script path");
    }
    return {
      command: "bun",
      args: ["run", input.scriptPath, ...daemonArgs],
    };
  }

  return {
    command: input.executablePath,
    args: daemonArgs,
  };
};

// ---------------------------------------------------------------------------
// Spawn + wait
// ---------------------------------------------------------------------------

export const spawnDetached = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
}): void => {
  const child = spawn(input.command, [...input.args], {
    detached: true,
    stdio: "ignore",
    env: input.env,
  });
  child.unref();
};

export const waitForReachable = async (input: {
  readonly check: () => Promise<boolean>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Promise<boolean> => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (await input.check()) return true;
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }
  return false;
};

export const waitForUnreachable = async (input: {
  readonly check: () => Promise<boolean>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Promise<boolean> => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (!(await input.check())) return true;
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }
  return false;
};
