import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";

export type LockRow = { owner_process_id: number | null; owner_process_name: string | null };

export type ProcessProbe = {
  isAlive(pid: number): boolean;
  nameOf(pid: number): string | null;
};

export const systemProbe: ProcessProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM: the process exists and belongs to another user. Spec 2.7 --
      // that is a live process, not a dead one.
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  nameOf(pid) {
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
      return out.trim() === "" ? null : out.trim();
    } catch {
      return null;
    }
  },
};

/**
 * Reads master.sqlite's lock table from the LIVE file, read-only. The one
 * exception to "everything through the snapshot" (spec 3.2): a snapshot
 * describes the past, and "is Serato running now" is a question about the
 * present.
 */
export function readLockRows(masterPath: string): LockRow[] | SeratoError {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(masterPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 3000");
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lock'")
      .get();
    if (hasTable === undefined) return [];
    return db.prepare("SELECT owner_process_id, owner_process_name FROM lock").all() as LockRow[];
  } catch (e) {
    // Unable to tell whether Serato is running is a refusal to write, never a
    // guess that it is not.
    return err("write_refused", `cannot read master.sqlite's lock table: ${String(e)}`, {
      reason: "lock_unreadable",
      rejected_track_ids: [],
    });
  } finally {
    db?.close();
  }
}

/**
 * A lock row counts only if its process is alive AND is still called what
 * the row says. The row survives an unclean shutdown -- measured 2026-09-03
 * after SIGTERM, and live on 2026-09-14 for pid 73438 -- and the OS recycles
 * pids, so either check alone gives a permanent false "running".
 */
export function findLiveSerato(
  rows: LockRow[],
  probe: ProcessProbe,
): { pid: number; name: string } | null {
  for (const row of rows) {
    const pid = row.owner_process_id;
    const expected = row.owner_process_name;
    if (pid === null || expected === null) continue;
    if (!probe.isAlive(pid)) continue;
    const actual = probe.nameOf(pid);
    if (actual === null) {
      // The name could not be read. If the process died in between, the row
      // is stale; if it is still alive, not knowing what it is must refuse,
      // never guess -- the same rule readLockRows follows.
      if (probe.isAlive(pid)) return { pid, name: expected };
      continue;
    }
    // `ps -o comm=` prints the full executable path for an app bundle on
    // macOS; the row holds the bare application name.
    if (actual === expected || basename(actual) === expected || actual.endsWith(`/${expected}`)) {
      return { pid, name: expected };
    }
  }
  return null;
}

export function checkSeratoClosed(
  masterPath: string,
  probe: ProcessProbe = systemProbe,
): null | SeratoError {
  const rows = readLockRows(masterPath);
  if (!Array.isArray(rows)) return rows;
  const live = findLiveSerato(rows, probe);
  if (live === null) return null;
  return err("serato_running", `${live.name} is running; quit it before applying changes`, {
    owner_process_id: live.pid,
    owner_process_name: live.name,
  });
}
