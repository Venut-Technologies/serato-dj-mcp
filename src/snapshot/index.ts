import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";

export type Snapshot = { path: string; generation: string; takenAt: number };

/**
 * Identity of the source's current content.
 *
 * Deliberately covers the main file and -wal but NOT -shm: measured
 * 2026-09-03 on Serato DJ Lite 4.0.9, a read-only read of a live WAL
 * database updates the mtime of -shm and nothing else. Keying off -shm would
 * make every query invalidate the snapshot it had just taken.
 *
 * SQLite's change counter at byte offset 24 is unusable here for the opposite
 * reason: in WAL mode it does not move until a checkpoint.
 */
export function stalenessKey(livePath: string): string {
  const parts: string[] = [];
  for (const p of [livePath, `${livePath}-wal`]) {
    try {
      const s = statSync(p);
      parts.push(`${p}:${s.mtimeMs}:${s.size}`);
    } catch {
      parts.push(`${p}:absent`);
    }
  }
  return parts.join("|");
}

function generationOf(livePath: string): string {
  return createHash("sha256").update(stalenessKey(livePath)).digest("hex").slice(0, 12);
}

/**
 * Takes a consistent copy of the live library.
 *
 * Uses backup() (SQLite Online Backup API, added in Node 22.16) rather than
 * copying master.sqlite and -wal with copyFileSync: the pair of copies is not
 * atomic, and with Serato writing between them the result is either corrupt
 * or -- worse, because nothing detects it -- silently stale.
 *
 * The copy inherits journal_mode=wal and grows its own sidecars when opened;
 * that is fine, it lives in a writable cache directory of ours.
 */
export async function takeSnapshot(
  livePath: string,
  cacheDir: string,
): Promise<Snapshot | SeratoError> {
  const generation = generationOf(livePath);
  mkdirSync(cacheDir, { recursive: true });
  const out = join(cacheDir, `snap-${generation}.sqlite`);

  if (existsSync(out)) return { path: out, generation, takenAt: Date.now() };

  let src: DatabaseSync;
  try {
    src = new DatabaseSync(livePath, { readOnly: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ENOENT and EACCES are different problems and must not collapse into one
    // code: "not found" sends the user to --library, "denied" sends them to
    // Full Disk Access.
    if (/EACCES|permission denied|unable to open database file/i.test(msg)) {
      return err("permission_denied", `cannot open ${livePath}: ${msg}`, {
        instructions:
          "On macOS, grant Full Disk Access to the process running this server " +
          "(System Settings > Privacy & Security > Full Disk Access), then retry.",
      });
    }
    return err("snapshot_failed", `cannot open ${livePath}: ${msg}`, { attempts: 1 });
  }

  try {
    for (const sidecar of ["", "-wal", "-shm"]) rmSync(out + sidecar, { force: true });
    await backup(src, out);
  } catch (e) {
    return err("snapshot_failed", `backup failed: ${e instanceof Error ? e.message : String(e)}`, {
      attempts: 1,
    });
  } finally {
    src.close();
  }

  let integrity = "";
  try {
    const dst = new DatabaseSync(out, { readOnly: true });
    integrity = (dst.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
      .integrity_check;
    dst.close();
  } catch (e) {
    return err(
      "snapshot_failed",
      `snapshot unreadable: ${e instanceof Error ? e.message : String(e)}`,
      {
        attempts: 1,
      },
    );
  }
  if (integrity !== "ok") {
    return err("snapshot_failed", `integrity_check returned ${integrity}`, { attempts: 1 });
  }

  return { path: out, generation, takenAt: Date.now() };
}
