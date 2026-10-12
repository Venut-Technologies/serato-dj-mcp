import { execFileSync } from "node:child_process";
import { basename, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";

export type LockRow = { owner_process_id: number | null; owner_process_name: string | null };

export type ProcessProbe = {
  isAlive(pid: number): boolean;
  nameOf(pid: number): string | null;
  /** Whether `actual`, as nameOf returned it, is the process a lock row calls
   *  `expected`. Left out, the POSIX rule applies (isNamedOnPosix). */
  isNamed?(actual: string, expected: string): boolean;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists and belongs to another user -- that is a
    // live process, not a dead one.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function posixNameOf(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "" ? null : out.trim();
  } catch {
    return null;
  }
}

/**
 * The image name out of `tasklist /FI "PID eq <pid>" /FO CSV /NH`, or null.
 *
 * Measured 2026-10-12 on Windows 11: a match is one line,
 *   "node.exe","37448","Console","1","59,800 K"
 * with the name in full (46 characters were not cut short, as the table
 * format would have); no match is a sentence on stdout with exit code 0,
 *   INFO: No tasks are running which match the specified criteria.
 * and that sentence is translated on a non-English Windows. So nothing is
 * read from the text: a line counts only if it is a quoted record whose
 * second field is the pid that was asked for.
 */
export function parseTasklistCsv(output: string, pid: number): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)",/.exec(line);
    if (match !== null && Number(match[2]) === pid) return match[1];
  }
  return null;
}

function windowsNameOf(pid: number): string | null {
  try {
    // By full path: Windows looks for a bare "tasklist" in the current
    // directory before System32, and an MCP client decides what this
    // server's current directory is.
    const tasklist = win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "tasklist.exe",
    );
    const out = execFileSync(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      // 139 ms when measured. Bounded because this server is synchronous;
      // running out of time reads as "name unknown", which refuses.
      timeout: 5000,
    });
    return parseTasklistCsv(out, pid);
  } catch {
    return null;
  }
}

/** `ps -o comm=` prints the full executable path for an app bundle on
 *  macOS; the row holds the bare application name. */
export function isNamedOnPosix(actual: string, expected: string): boolean {
  return actual === expected || basename(actual) === expected || actual.endsWith(`/${expected}`);
}

/**
 * NOT MEASURED: no lock row written by Serato on Windows has been seen, so
 * what owner_process_name holds there is unknown -- "Serato DJ Pro", "Serato
 * DJ Pro.exe" or a full path are all plausible. tasklist reports the image
 * name with its extension. The two are therefore compared as bare names:
 * directory and ".exe" dropped, case ignored, as Windows itself ignores it.
 *
 * Should the row hold something else again, that comparison would call a
 * running Serato "some other process" and let a write through. The second
 * test closes that direction without knowing the row's format: a live pid
 * from the lock table whose image name starts with "serato" counts as
 * running, whatever the row calls it. Its cost is a refusal when a stale
 * row's pid has been reused by another Serato program, which quitting that
 * program clears.
 */
export function isNamedOnWindows(actual: string, expected: string): boolean {
  const bare = (name: string) => {
    const base = win32.basename(name).toLowerCase();
    return base.endsWith(".exe") ? base.slice(0, -".exe".length) : base;
  };
  return bare(actual) === bare(expected) || bare(actual).startsWith("serato");
}

/** Windows has no `ps`, and names its processes differently. */
export function createSystemProbe(platform: NodeJS.Platform): ProcessProbe {
  return platform === "win32"
    ? { isAlive, nameOf: windowsNameOf, isNamed: isNamedOnWindows }
    : { isAlive, nameOf: posixNameOf, isNamed: isNamedOnPosix };
}

export const systemProbe: ProcessProbe = createSystemProbe(process.platform);

/**
 * Reads master.sqlite's lock table from the LIVE file, read-only. Every other
 * read in this server goes through a snapshot copy; this one cannot, because
 * a snapshot describes the past and "is Serato running now" is a question
 * about the present.
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
    if ((probe.isNamed ?? isNamedOnPosix)(actual, expected)) return { pid, name: expected };
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
