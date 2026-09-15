import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";

/** Spec 7: backups are kept, not merely cached -- the last ten per library. */
export const MAX_BACKUPS = 10;

export type BackupPaths = { root: string; master: string };

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.(\d{3})Z$/, "-$1");

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const failed = (message: string) => err("write_failed_not_committed", message, { stage: "backup" });

/**
 * Backs up both databases before any write, fail-closed (spec 5.1.4).
 *
 * root.sqlite is a plain file copy verified by hash: it runs in journal_mode
 * DELETE with no sidecars, and apply refuses earlier if a root.sqlite-journal
 * exists. master.sqlite goes through backup() on a read-only connection --
 * never a file copy, which is not atomic against its -wal, and never a
 * checkpoint of the live file.
 */
export async function backupLibrary(
  libraryPath: string,
  stateDir: string,
  libraryId: string,
  now: Date = new Date(),
): Promise<BackupPaths | SeratoError> {
  const libraryBackups = join(stateDir, "backups", libraryId);
  const dir = join(libraryBackups, stamp(now));
  const paths: BackupPaths = { root: join(dir, "root.sqlite"), master: join(dir, "master.sqlite") };
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return failed(`cannot create the backup directory: ${String(e)}`);
  }

  try {
    const source = join(libraryPath, "root.sqlite");
    copyFileSync(source, paths.root);
    if (sha256(source) !== sha256(paths.root)) {
      rmSync(dir, { recursive: true, force: true });
      return failed("the root.sqlite backup does not match the original byte for byte");
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return failed(`cannot back up root.sqlite: ${String(e)}`);
  }

  let src: DatabaseSync | undefined;
  try {
    src = new DatabaseSync(join(libraryPath, "master.sqlite"), { readOnly: true });
    await backup(src, paths.master);
    const copy = new DatabaseSync(paths.master, { readOnly: true });
    try {
      const { integrity_check } = copy.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (integrity_check !== "ok") throw new Error(`integrity_check returned ${integrity_check}`);
    } finally {
      copy.close();
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return failed(`cannot back up master.sqlite: ${String(e)}`);
  } finally {
    src?.close();
  }

  // Retention never fails a backup that already succeeded: an old directory
  // we cannot delete is a disk-space problem, not a reason to refuse a write.
  try {
    const all = readdirSync(libraryBackups).sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
      rmSync(join(libraryBackups, old), { recursive: true, force: true });
    }
  } catch {
    // see above
  }
  return paths;
}
