import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";
import { buildDerived, DERIVED_VERSION } from "./derive.js";

const FULL_DISK_ACCESS_INSTRUCTIONS =
  "On macOS, grant Full Disk Access to the process running this server " +
  "(System Settings > Privacy & Security > Full Disk Access), then retry.";

export type Snapshot = { path: string; generation: string; takenAt: number };

/** While Serato is running the library changes constantly, so every call
 *  would otherwise compute a fresh generation and copy the whole database
 *  again. Within this window the last snapshot is served instead -- it is a
 *  real, consistent copy, just up to 2 s behind. */
export const SNAPSHOT_THROTTLE_MS = 2_000;

/** A temp file this old cannot belong to a live backup (they take
 *  milliseconds on a 4.6 MB library), so it is the debris of a killed
 *  process and is swept. */
const TEMP_MAX_AGE_MS = 60 * 60 * 1_000;

/** Last snapshot per live path, for the throttle above. Bounded by the
 *  number of libraries this process has read, not by the number of calls. */
const recent = new Map<string, Snapshot>();

/** Identifies the library a cache entry belongs to, so eviction can delete
 *  every older generation of THIS library and leave other libraries' entries
 *  alone -- a user with an external drive has several, all sharing one cache
 *  directory. */
function libraryKey(livePath: string): string {
  return createHash("sha256").update(livePath).digest("hex").slice(0, 12);
}

/**
 * Snapshots are retained "until (mtime, size) changes" -- so once a newer
 * generation of this library is published, every older one is debris.
 * Deleting a file another reader still has open is safe on macOS: the open
 * handle keeps reading the unlinked inode.
 *
 * Never allowed to fail a snapshot that has already succeeded: a cache
 * directory we cannot tidy is a disk-space problem, not a reason to refuse
 * the caller the copy it just got.
 */
function evictOlderEntries(cacheDir: string, prefix: string, keep: string): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    // startsWith(keep), not ===: the published snapshot's own -wal and -shm
    // sidecars share its name as a prefix and must survive with it.
    if (name.startsWith(keep)) continue;
    try {
      if (name.startsWith(`snap-${prefix}-`)) {
        rmSync(join(cacheDir, name), { force: true });
      } else if (name.startsWith(`.tmp-${prefix}-`)) {
        const age = now - statSync(join(cacheDir, name)).mtimeMs;
        if (age > TEMP_MAX_AGE_MS) rmSync(join(cacheDir, name), { force: true });
      }
    } catch {
      // Someone else's concurrent eviction, or a read-only cache dir.
    }
  }
}

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
 *
 * Publishing is itself atomic: backup() writes to a temp file, which is
 * integrity-checked and only then renamed to snap-<generation>.sqlite. That
 * final name is therefore never created except by a passed integrity_check,
 * so the reuse fast-path below can trust its mere existence instead of
 * re-verifying it on every call -- a killed process or a failed backup
 * leaves at most a stray temp file, never a poisoned entry at the final
 * name. Fixed 2026-09-06: the previous version wrote straight to the final
 * name and never cleaned it up on failure, so a truncated file from a failed
 * attempt was served as a valid snapshot on the next call.
 */
export async function takeSnapshot(
  livePath: string,
  cacheDir: string,
  opts: { throttleMs?: number } = {},
): Promise<Snapshot | SeratoError> {
  const throttleMs = opts.throttleMs ?? SNAPSHOT_THROTTLE_MS;
  const last = recent.get(livePath);
  // Checked before the two stat calls in generationOf(), because the point
  // is to answer without touching the live database at all while Serato is
  // hammering it. existsSync guards the case where the entry was evicted
  // from under us -- another process, or macOS purging ~/Library/Caches.
  if (last !== undefined && Date.now() - last.takenAt < throttleMs && existsSync(last.path)) {
    return last;
  }

  const generation = generationOf(livePath);
  const prefix = libraryKey(livePath);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (e) {
    // Errors are values, never thrown across this boundary (see errors.ts):
    // a bad cacheDir (e.g. a path component that is actually a regular
    // file, giving ENOTDIR) must not escape as a raw Error, since runSql's
    // own "never throws" property depends on every call it makes upholding
    // that contract.
    return err(
      "snapshot_failed",
      `cannot create cache directory ${cacheDir}: ${e instanceof Error ? e.message : String(e)}`,
      { attempts: 1 },
    );
  }
  // The derived version is part of the name, not of the content: a snapshot
  // from an older build must not be reusable, and the eviction sweep below
  // deletes it along with every other older generation of this library.
  const out = join(cacheDir, `snap-${prefix}-${generation}-d${DERIVED_VERSION}.sqlite`);

  // Reuse: the source has not changed since this file was published, so its
  // content is current and the throttle window restarts from now.
  if (existsSync(out)) return remember(livePath, { path: out, generation, takenAt: Date.now() });

  // existsSync collapses every stat failure into "missing", including a
  // permission error on a macOS install with restricted Full Disk Access --
  // exactly the ENOENT/EACCES confusion the catch below (for the open
  // itself) exists to avoid, one layer up. statSync's errno tells the two
  // apart: ENOENT really is missing; anything else means the path exists
  // but this process cannot see it.
  try {
    statSync(livePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return err("library_not_found", `no such file: ${livePath}`, { searched: [livePath] });
    }
    return err(
      "permission_denied",
      `cannot stat ${livePath}: ${e instanceof Error ? e.message : String(e)}`,
      { instructions: FULL_DISK_ACCESS_INSTRUCTIONS },
    );
  }

  let src: DatabaseSync;
  try {
    src = new DatabaseSync(livePath, { readOnly: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // node:sqlite throws the identical "unable to open database file" for a
    // missing path and for one that exists but can't be read, so the two
    // cannot be told apart by message text -- that's why "missing" is ruled
    // out above with a stat instead of a regex here. Anything that reaches
    // this catch therefore exists but is unreadable: "not found" sends the
    // user to --library, "denied" sends them to Full Disk Access.
    return err("permission_denied", `cannot open ${livePath}: ${msg}`, {
      instructions: FULL_DISK_ACCESS_INSTRUCTIONS,
    });
  }

  // randomUUID, not Date.now(): two concurrent takeSnapshot() calls for the
  // same generation in one process must never compute the same temp path.
  // Measured 2026-09-06 with millisecond-only uniqueness: about 40% of 20
  // concurrent call pairs failed with "database is locked" or a disk I/O
  // error because both calls' backup() raced over one temp file.
  const tmp = join(cacheDir, `.tmp-${prefix}-${generation}-${process.pid}-${randomUUID()}.sqlite`);
  const cleanupTmp = () => {
    for (const sidecar of ["", "-wal", "-shm"]) rmSync(tmp + sidecar, { force: true });
  };

  try {
    cleanupTmp();
    await backup(src, tmp);
  } catch (e) {
    cleanupTmp();
    return err("snapshot_failed", `backup failed: ${e instanceof Error ? e.message : String(e)}`, {
      attempts: 1,
    });
  } finally {
    src.close();
  }

  // Derived data goes in before the integrity check, so a snapshot is
  // published only if it passed the check WITH our tables in it. Failure
  // here is snapshot_failed like any other: errors are values (see
  // errors.ts), and a half-derived file must never reach the final name.
  try {
    const writable = new DatabaseSync(tmp);
    try {
      buildDerived(writable);
    } finally {
      writable.close();
    }
  } catch (e) {
    cleanupTmp();
    return err("snapshot_failed", `derive failed: ${e instanceof Error ? e.message : String(e)}`, {
      attempts: 1,
    });
  }

  let integrity: string;
  try {
    const dst = new DatabaseSync(tmp, { readOnly: true });
    try {
      integrity = (dst.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
        .integrity_check;
    } finally {
      dst.close();
    }
  } catch (e) {
    cleanupTmp();
    return err(
      "snapshot_failed",
      `snapshot unreadable: ${e instanceof Error ? e.message : String(e)}`,
      {
        attempts: 1,
      },
    );
  }
  if (integrity !== "ok") {
    cleanupTmp();
    return err("snapshot_failed", `integrity_check returned ${integrity}`, { attempts: 1 });
  }

  try {
    // Only a temp file that has passed integrity_check ever reaches the
    // final name. Its own sidecars are dropped rather than carried over:
    // they are at most an artifact of the read-only check above, and the
    // destination grows fresh ones on its own the next time something opens
    // it.
    rmSync(`${tmp}-wal`, { force: true });
    rmSync(`${tmp}-shm`, { force: true });
    renameSync(tmp, out);
  } catch (e) {
    // Errors are values, never thrown across this boundary (see errors.ts):
    // a rename can fail (EACCES, disk full, a cross-device cache dir) after
    // the temp file has already passed integrity_check, and letting that
    // throw a raw Error here would break that contract and leak the temp
    // file besides.
    cleanupTmp();
    return err("snapshot_failed", `publish failed: ${e instanceof Error ? e.message : String(e)}`, {
      attempts: 1,
    });
  }

  evictOlderEntries(cacheDir, prefix, `snap-${prefix}-${generation}-d${DERIVED_VERSION}.sqlite`);
  return remember(livePath, { path: out, generation, takenAt: Date.now() });
}

/** Records what the throttle above will serve for the next window. */
function remember(livePath: string, snap: Snapshot): Snapshot {
  recent.set(livePath, snap);
  return snap;
}
