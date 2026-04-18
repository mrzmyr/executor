import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalDaemonHost,
  isPidAlive,
  readDaemonRecord,
  removeDaemonRecord,
  writeDaemonRecord,
} from "../apps/cli/src/daemon-state";

describe("daemon state", () => {
  it("normalizes local host aliases", () => {
    expect(canonicalDaemonHost("localhost")).toBe("localhost");
    expect(canonicalDaemonHost("127.0.0.1")).toBe("localhost");
    expect(canonicalDaemonHost("::1")).toBe("localhost");
    expect(canonicalDaemonHost("0.0.0.0")).toBe("localhost");
    expect(canonicalDaemonHost("api.example.com")).toBe("api.example.com");
  });

  it("writes, reads, and removes daemon records", async () => {
    const prev = process.env.EXECUTOR_DATA_DIR;
    const dir = mkdtempSync(join(tmpdir(), "executor-daemon-state-test-"));
    process.env.EXECUTOR_DATA_DIR = dir;

    try {
      await writeDaemonRecord({
        hostname: "127.0.0.1",
        port: 4788,
        pid: 12345,
        scopeDir: "/tmp/scope",
      });

      const stored = await readDaemonRecord({ hostname: "localhost", port: 4788 });
      expect(stored).toEqual({
        version: 1,
        hostname: "localhost",
        port: 4788,
        pid: 12345,
        startedAt: expect.any(String),
        scopeDir: "/tmp/scope",
      });

      await removeDaemonRecord({ hostname: "localhost", port: 4788 });
      const after = await readDaemonRecord({ hostname: "localhost", port: 4788 });
      expect(after).toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.EXECUTOR_DATA_DIR;
      } else {
        process.env.EXECUTOR_DATA_DIR = prev;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects live and invalid pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(-1)).toBe(false);
  });
});
