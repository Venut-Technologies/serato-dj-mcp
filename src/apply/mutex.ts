import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";

/** Matches busy_timeout in the transaction: a caller told to retry after this
 *  long will find either the lock free or a fresh reason. */
export const WRITE_LOCK_RETRY_MS = 3000;

/** SQLITE_BUSY is primary result code 5; node:sqlite reports it, or an
 *  extended variant of it, as errcode. */
const isBusy = (e: unknown) => (((e as { errcode?: number }).errcode ?? -1) & 0xff) === 5;

/**
 * Exclusive per-library lock for the duration of apply_changes (spec 5.0,
 * amendment 5).
 *
 * The lock is SQLite's own: an EXCLUSIVE transaction on an empty database in
 * the state directory, held open until release(). SQLite takes it with a POSIX
 * advisory lock, and the kernel drops that lock the moment the holding process
 * exits, however it exits. So there is no stale lock to detect and no takeover
 * to race. The lock file with a pid in it that this replaced needed both, and
 * review found that every takeover left a window: a live lock moved aside for
 * an instant is a free path a third process can walk into.
 *
 * Within one process SQLite tracks locks per file across connections, so a
 * second acquire from the same server is refused as well.
 */
export function acquireWriteLock(
  stateDir: string,
  libraryId: string,
): { release(): void } | SeratoError {
  let db: DatabaseSync | undefined;
  try {
    const dir = join(stateDir, "locks");
    mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(join(dir, `${libraryId}.lock.sqlite`));
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    db?.close();
    if (isBusy(e)) {
      return err("busy", "another serato-dj-mcp is applying changes to this library", {
        retry_after_ms: WRITE_LOCK_RETRY_MS,
      });
    }
    return err("write_failed_not_committed", `cannot take the write lock: ${String(e)}`, {
      stage: "lock",
    });
  }
  const held = db;
  return {
    release() {
      // Closing ends the transaction and drops the lock; the ROLLBACK first
      // only makes that explicit. Nothing was ever written to this database.
      try {
        held.exec("ROLLBACK");
      } catch {
        // already ended; close below still releases the lock
      } finally {
        held.close();
      }
    },
  };
}
