import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWriteLock } from "../../src/apply/mutex.js";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { isSeratoError } from "../../src/errors.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-mutex-"));
const alive = (pids: number[]): ProcessProbe => ({
  isAlive: (pid) => pids.includes(pid),
  nameOf: () => "node",
});
const lockFile = (dir: string) => join(dir, "locks", "lib000000001.lock");
const writeHolder = (dir: string, holder: { pid: number; name?: string }) => {
  mkdirSync(join(dir, "locks"), { recursive: true });
  writeFileSync(lockFile(dir), JSON.stringify({ ...holder, acquired_at: "2026-09-01T00:00:00Z" }));
};

describe("acquireWriteLock", () => {
  it("takes the lock and releases it, leaving nothing behind", () => {
    const dir = tmp();
    const lock = acquireWriteLock(dir, "lib000000001");
    if (isSeratoError(lock)) throw new Error("unexpected error");
    expect(existsSync(lockFile(dir))).toBe(true);
    lock.release();
    // No lock file, and no temp or set-aside file from the create or takeover.
    expect(readdirSync(join(dir, "locks"))).toEqual([]);
  });

  it("refuses a second holder with busy and a retry hint", () => {
    const dir = tmp();
    const first = acquireWriteLock(dir, "lib000000001", alive([process.pid]));
    if (isSeratoError(first)) throw new Error("unexpected error");
    const second = acquireWriteLock(dir, "lib000000001", alive([process.pid]));
    expect(isSeratoError(second)).toBe(true);
    if (isSeratoError(second)) {
      expect(second.error.code).toBe("busy");
      expect(second.error.details?.retry_after_ms).toBe(3000);
    }
    first.release();
  });

  // A server killed mid-apply leaves its lock file behind. Refusing forever
  // because of it would be the file-lock twin of the stale Serato lock row.
  it("takes over a lock whose holder is dead", () => {
    const dir = tmp();
    writeHolder(dir, { pid: 999_999, name: "node" });
    const lock = acquireWriteLock(dir, "lib000000001", alive([]));
    expect(isSeratoError(lock)).toBe(false);
    if (!isSeratoError(lock)) lock.release();
  });

  // The same twin of findLiveSerato's rule: a recycled pid that now runs
  // something else does not hold the lock.
  it("takes over a lock whose pid now belongs to another program", () => {
    const dir = tmp();
    writeHolder(dir, { pid: 500, name: "node" });
    const recycled: ProcessProbe = {
      isAlive: (pid) => pid === 500,
      nameOf: (pid) => (pid === 500 ? "/usr/bin/vim" : "node"),
    };
    const lock = acquireWriteLock(dir, "lib000000001", recycled);
    expect(isSeratoError(lock)).toBe(false);
    if (!isSeratoError(lock)) lock.release();
  });

  it("treats an unreadable lock file as stale rather than blocking forever", () => {
    const dir = tmp();
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(lockFile(dir), "garbage");
    const lock = acquireWriteLock(dir, "lib000000001", alive([]));
    expect(isSeratoError(lock)).toBe(false);
    if (!isSeratoError(lock)) lock.release();
  });

  // Two contenders can both judge the same file stale. If the other one has
  // already replaced it with its own live lock by the time we remove it, we
  // must put that lock back and report busy, not delete it and move in.
  it("puts back a live lock that replaced the stale one during takeover", () => {
    const dir = tmp();
    writeHolder(dir, { pid: 999_999, name: "node" });
    const racing: ProcessProbe = {
      isAlive: (pid) => {
        if (pid === 999_999) {
          // The other contender wins the takeover between our read and our move.
          writeHolder(dir, { pid: 424_242, name: "node" });
          return false;
        }
        return pid === 424_242;
      },
      nameOf: () => "node",
    };
    const lock = acquireWriteLock(dir, "lib000000001", racing);
    expect(isSeratoError(lock) && lock.error.code).toBe("busy");
    expect(JSON.parse(readFileSync(lockFile(dir), "utf8")).pid).toBe(424_242);
    expect(readdirSync(join(dir, "locks"))).toEqual(["lib000000001.lock"]);
  });

  // release() must not delete a lock someone else took over after ours was
  // judged stale -- that would let a third process in alongside them.
  it("does not release a lock it no longer holds", () => {
    const dir = tmp();
    const lock = acquireWriteLock(dir, "lib000000001");
    if (isSeratoError(lock)) throw new Error("unexpected error");
    writeFileSync(
      lockFile(dir),
      JSON.stringify({ pid: 424242, acquired_at: "2026-09-14T00:00:00Z" }),
    );
    lock.release();
    expect(existsSync(lockFile(dir))).toBe(true);
  });

  it("keeps locks of different libraries apart", () => {
    const dir = tmp();
    const a = acquireWriteLock(dir, "lib000000001");
    const b = acquireWriteLock(dir, "lib000000002");
    expect(isSeratoError(a) || isSeratoError(b)).toBe(false);
    if (!isSeratoError(a)) a.release();
    if (!isSeratoError(b)) b.release();
  });
});
