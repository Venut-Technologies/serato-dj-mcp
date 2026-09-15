import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWriteLock } from "../../src/apply/mutex.js";
import { isSeratoError } from "../../src/errors.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-mutex-"));

/** Another process holding the lock the way a second server instance would:
 *  its own SQLite connection, EXCLUSIVE, never released on its own. Spawns
 *  only -- the caller awaits "held" itself, inside its own try/finally, so a
 *  hang waiting for that line can never leave this child unkilled. */
function holderProcess(stateDir: string): ChildProcess {
  const script = `
    const { mkdirSync } = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    mkdirSync(process.argv[1] + "/locks", { recursive: true });
    const db = new DatabaseSync(process.argv[1] + "/locks/lib000000001.lock.sqlite");
    db.exec("BEGIN EXCLUSIVE");
    process.stdout.write("held\\n");
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, ["--no-warnings", "-e", script, stateDir], {
    stdio: ["ignore", "pipe", "ignore"],
  });
}

describe("acquireWriteLock", () => {
  it("takes the lock, and a released lock can be taken again", () => {
    const dir = tmp();
    const first = acquireWriteLock(dir, "lib000000001");
    if (isSeratoError(first)) throw new Error(`unexpected error: ${first.error.message}`);
    first.release();
    const second = acquireWriteLock(dir, "lib000000001");
    expect(isSeratoError(second)).toBe(false);
    if (!isSeratoError(second)) second.release();
  });

  it("is idempotent: releasing twice does not throw, and the lock can be taken again", () => {
    const dir = tmp();
    const first = acquireWriteLock(dir, "lib000000001");
    if (isSeratoError(first)) throw new Error(`unexpected error: ${first.error.message}`);
    first.release();
    expect(() => first.release()).not.toThrow();
    const second = acquireWriteLock(dir, "lib000000001");
    expect(isSeratoError(second)).toBe(false);
    if (!isSeratoError(second)) second.release();
  });

  it("refuses a second holder in the same process with busy and a retry hint", () => {
    const dir = tmp();
    const first = acquireWriteLock(dir, "lib000000001");
    if (isSeratoError(first)) throw new Error("unexpected error");
    try {
      const second = acquireWriteLock(dir, "lib000000001");
      expect(isSeratoError(second) && second.error.code).toBe("busy");
      if (isSeratoError(second)) expect(second.error.details?.retry_after_ms).toBe(3000);
    } finally {
      first.release();
    }
  });

  // The case the pid-file lock could not get right: a second server instance
  // holds the lock, then dies without any chance to clean up. The kernel drops
  // its lock with it, so there is nothing stale to detect or take over.
  it("refuses while another process holds the lock, and is free once that process is killed", async () => {
    const dir = tmp();
    const child = holderProcess(dir);
    try {
      await once(child.stdout as NodeJS.ReadableStream, "data");
      const blocked = acquireWriteLock(dir, "lib000000001");
      expect(isSeratoError(blocked) && blocked.error.code).toBe("busy");
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    const after = acquireWriteLock(dir, "lib000000001");
    expect(isSeratoError(after)).toBe(false);
    if (!isSeratoError(after)) after.release();
  });

  it("keeps locks of different libraries apart", () => {
    const dir = tmp();
    const a = acquireWriteLock(dir, "lib000000001");
    const b = acquireWriteLock(dir, "lib000000002");
    expect(isSeratoError(a) || isSeratoError(b)).toBe(false);
    if (!isSeratoError(a)) a.release();
    if (!isSeratoError(b)) b.release();
  });

  it("fails as not committed, not busy, when the lock cannot be created at all", () => {
    const file = join(tmp(), "not-a-directory");
    writeFileSync(file, "");
    const r = acquireWriteLock(file, "lib000000001");
    expect(isSeratoError(r) && r.error.code).toBe("write_failed_not_committed");
    if (isSeratoError(r)) expect(r.error.details?.stage).toBe("lock");
  });
});
