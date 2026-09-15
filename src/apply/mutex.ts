import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, type SeratoError } from "../errors.js";
import { type ProcessProbe, systemProbe } from "./serato.js";

/** Matches busy_timeout in the transaction: a caller told to retry after this
 *  long will find either the lock free or a fresh reason. */
export const WRITE_LOCK_RETRY_MS = 3000;

type Holder = { pid: number; name: string | null };

function readHolder(path: string): Holder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; name?: unknown };
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, name: typeof parsed.name === "string" ? parsed.name : null };
  } catch {
    return null;
  }
}

/**
 * A holder counts while its pid is alive and still runs the program that took
 * the lock -- the same rule findLiveSerato applies to Serato's own lock row,
 * for the same reasons: a killed server leaves the file, and pids are
 * recycled. A live pid whose name cannot be read still counts: refuse, never
 * guess.
 */
function isLiveHolder(holder: Holder, probe: ProcessProbe): boolean {
  if (!probe.isAlive(holder.pid)) return false;
  if (holder.name === null) return true;
  const now = probe.nameOf(holder.pid);
  return now === null || now === holder.name;
}

const busy = (holder?: Holder): SeratoError =>
  err("busy", "another serato-dj-mcp is applying changes to this library", {
    retry_after_ms: WRITE_LOCK_RETRY_MS,
    ...(holder === undefined ? {} : { holder_pid: holder.pid }),
  });

const lockFailed = (e: unknown): SeratoError =>
  err("write_failed_not_committed", `cannot take the write lock: ${String(e)}`, { stage: "lock" });

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * Exclusive per-library lock for the duration of apply_changes (spec 5.0).
 *
 * The lock file is created by link(2) from a fully written temp file, never by
 * open(O_EXCL) and a write after it: link is just as atomic, and a contender
 * can never catch the file empty, read "no holder" and take over a lock that
 * is in use.
 *
 * A stale file -- dead holder, recycled pid, garbage -- is taken over once.
 * The takeover moves the file aside under a name only this process uses and
 * then looks at what it actually moved: another contender may have replaced
 * the stale file with its own live lock in between, and that one is put back.
 */
export function acquireWriteLock(
  stateDir: string,
  libraryId: string,
  probe: ProcessProbe = systemProbe,
): { release(): void } | SeratoError {
  const dir = join(stateDir, "locks");
  const path = join(dir, `${libraryId}.lock`);
  const self: Holder = { pid: process.pid, name: probe.nameOf(process.pid) };
  const temp = `${path}.${process.pid}.tmp`;
  const aside = `${path}.${process.pid}.stale`;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify({ ...self, acquired_at: new Date().toISOString() }));
  } catch (e) {
    rmSync(temp, { force: true });
    return lockFailed(e);
  }

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(temp, path);
        return {
          release() {
            // Only our own lock: after a takeover the file belongs to someone
            // else, and deleting it would let a third process in.
            if (readHolder(path)?.pid === process.pid) rmSync(path, { force: true });
          },
        };
      } catch (e) {
        if (code(e) !== "EEXIST") return lockFailed(e);
      }

      const holder = readHolder(path);
      if (holder !== null && isLiveHolder(holder, probe)) return busy(holder);

      try {
        renameSync(path, aside);
      } catch (e) {
        // Gone already: someone else removed it. Try to create ours again.
        if (code(e) === "ENOENT") continue;
        return lockFailed(e);
      }
      const moved = readHolder(aside);
      if (moved !== null && isLiveHolder(moved, probe)) {
        // Not the stale file any more. Put it back; if a third contender has
        // already created a lock, that one stands and ours is still refused.
        try {
          linkSync(aside, path);
        } catch {
          // EEXIST: a live lock is in place either way.
        }
        rmSync(aside, { force: true });
        return busy(moved);
      }
      rmSync(aside, { force: true });
    }
    return busy();
  } finally {
    rmSync(temp, { force: true });
  }
}
