import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  checkSeratoClosed,
  createSystemProbe,
  findLiveSerato,
  isNamedOnPosix,
  isNamedOnWindows,
  type ProcessProbe,
  parseTasklistCsv,
  readLockRows,
  systemProbe,
} from "../../src/apply/serato.js";
import { isSeratoError } from "../../src/errors.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-lock-"));

/** A probe that knows exactly which pids are alive and what they are called,
 *  so the rules are tested without depending on real processes. */
const probe = (alive: Record<number, string>): ProcessProbe => ({
  isAlive: (pid) => Object.hasOwn(alive, pid),
  nameOf: (pid) => alive[pid] ?? null,
});

function masterWithLock(rows: [number, string][]): string {
  const path = makeMasterFixture(tmp(), { tracks: [] });
  const db = new DatabaseSync(path);
  const ins = db.prepare(
    "INSERT INTO lock (time_locked, lock_policy, owner_process_id, owner_process_name) VALUES (?, 1, ?, ?)",
  );
  for (const [pid, name] of rows) ins.run(1_788_692_946, pid, name);
  db.close();
  return path;
}

describe("findLiveSerato", () => {
  // The live library carries exactly this on 2026-09-14: a lock row for pid
  // 73438, a process killed without a clean shutdown. Trusting the row would
  // refuse every write forever.
  it("ignores a lock row whose process is dead", () => {
    const rows = [{ owner_process_id: 73438, owner_process_name: "Serato DJ Lite" }];
    expect(findLiveSerato(rows, probe({}))).toBeNull();
  });

  it("reports a live process whose name matches", () => {
    const rows = [{ owner_process_id: 500, owner_process_name: "Serato DJ Lite" }];
    expect(findLiveSerato(rows, probe({ 500: "Serato DJ Lite" }))).toEqual({
      pid: 500,
      name: "Serato DJ Lite",
    });
  });

  // macOS `ps -o comm=` prints the full executable path for an app bundle.
  it("matches the name against a full executable path", () => {
    const rows = [{ owner_process_id: 500, owner_process_name: "Serato DJ Lite" }];
    const path = "/Applications/Serato DJ Lite.app/Contents/MacOS/Serato DJ Lite";
    expect(findLiveSerato(rows, probe({ 500: path }))).not.toBeNull();
  });

  // A pid is reused by the OS. A live process under a recycled pid that is
  // not Serato must not block writes.
  it("ignores a live pid that now belongs to something else", () => {
    const rows = [{ owner_process_id: 500, owner_process_name: "Serato DJ Lite" }];
    expect(findLiveSerato(rows, probe({ 500: "/usr/bin/vim" }))).toBeNull();
  });

  it("is running if any one of several rows is live", () => {
    const rows = [
      { owner_process_id: 1, owner_process_name: "Serato DJ Lite" },
      { owner_process_id: 2, owner_process_name: "Serato DJ Pro" },
    ];
    expect(findLiveSerato(rows, probe({ 2: "Serato DJ Pro" }))?.pid).toBe(2);
  });

  it("treats a live pid whose name cannot be read as running", () => {
    const rows = [{ owner_process_id: 500, owner_process_name: "Serato DJ Lite" }];
    const unnameable: ProcessProbe = { isAlive: () => true, nameOf: () => null };
    expect(findLiveSerato(rows, unnameable)).toEqual({ pid: 500, name: "Serato DJ Lite" });
  });

  it("skips a row with no pid", () => {
    expect(
      findLiveSerato([{ owner_process_id: null, owner_process_name: "X" }], probe({})),
    ).toBeNull();
  });

  // The outer `isAlive` gate must reject a dead pid before the name is ever
  // re-probed -- distinct from the re-probe path for a live pid whose name
  // cannot be read (tested above). A probe that lies and says the name is
  // readable must not matter once isAlive has already said no.
  it("never re-probes the name once the outer isAlive gate says the pid is dead", () => {
    const rows = [{ owner_process_id: 500, owner_process_name: "Serato DJ Lite" }];
    const deadButNameable: ProcessProbe = { isAlive: () => false, nameOf: () => "Serato DJ Lite" };
    expect(findLiveSerato(rows, deadButNameable)).toBeNull();
  });
});

/** The same, naming processes the way the Windows probe does. */
const windowsProbe = (alive: Record<number, string>): ProcessProbe => ({
  ...probe(alive),
  isNamed: isNamedOnWindows,
});

// What a lock row holds on Windows has NOT been measured: these pin the
// rules chosen for that unknown, not an observation of Serato.
describe("findLiveSerato, naming processes as Windows does", () => {
  const row = (name: string) => [{ owner_process_id: 500, owner_process_name: name }];

  // tasklist reports the image name with its extension; the row may or may
  // not carry it.
  it("matches an image name with .exe against a row without it, and the reverse", () => {
    expect(
      findLiveSerato(row("Serato DJ Pro"), windowsProbe({ 500: "Serato DJ Pro.exe" })),
    ).toEqual({ pid: 500, name: "Serato DJ Pro" });
    expect(
      findLiveSerato(row("Serato DJ Pro.exe"), windowsProbe({ 500: "Serato DJ Pro.exe" })),
    ).not.toBeNull();
  });

  it("ignores case, as Windows does for file names", () => {
    expect(
      findLiveSerato(row("serato dj pro.EXE"), windowsProbe({ 500: "Serato DJ Pro.exe" })),
    ).not.toBeNull();
  });

  it("matches a row that holds the executable's full path", () => {
    const path = "C:\\Program Files\\Serato\\Serato DJ Pro\\Serato DJ Pro.exe";
    expect(findLiveSerato(row(path), windowsProbe({ 500: "Serato DJ Pro.exe" }))).not.toBeNull();
  });

  // Whatever the row turns out to hold, a live pid from the lock table that
  // is a Serato program must refuse the write.
  it("counts a live Serato image as running even when the row calls it something else", () => {
    expect(
      findLiveSerato(row("some name nobody predicted"), windowsProbe({ 500: "Serato DJ Pro.exe" })),
    ).toEqual({ pid: 500, name: "some name nobody predicted" });
  });

  // Pids are reused on Windows as everywhere else.
  it("ignores a live pid that now belongs to something else", () => {
    expect(findLiveSerato(row("Serato DJ Pro"), windowsProbe({ 500: "notepad.exe" }))).toBeNull();
    // A name that merely contains the row's name is not that process.
    expect(
      findLiveSerato(row("DJ Pro"), windowsProbe({ 500: "Not DJ Pro Helper.exe" })),
    ).toBeNull();
  });

  it("ignores a dead pid, and refuses on a live one whose name cannot be read", () => {
    expect(findLiveSerato(row("Serato DJ Pro"), windowsProbe({}))).toBeNull();
    const unnameable: ProcessProbe = {
      isAlive: () => true,
      nameOf: () => null,
      isNamed: isNamedOnWindows,
    };
    expect(findLiveSerato(row("Serato DJ Pro"), unnameable)).toEqual({
      pid: 500,
      name: "Serato DJ Pro",
    });
  });

  // The POSIX rule is exact: none of the Windows tolerance leaks into it.
  it("keeps the POSIX comparison exact", () => {
    expect(isNamedOnPosix("Serato DJ Lite.exe", "Serato DJ Lite")).toBe(false);
    expect(isNamedOnPosix("serato dj lite", "Serato DJ Lite")).toBe(false);
    expect(isNamedOnPosix("/usr/bin/serato-helper", "Serato DJ Lite")).toBe(false);
    expect(findLiveSerato(row("Serato DJ Lite"), probe({ 500: "Serato DJ Lite.exe" }))).toBeNull();
  });
});

// Measured 2026-10-12 on Windows 11 with
//   tasklist /FI "PID eq <pid>" /FO CSV /NH
describe("parseTasklistCsv", () => {
  it("takes the image name from the record for the pid that was asked for", () => {
    const out = '"node.exe","37448","Console","1","59,800 K"\r\n';
    expect(parseTasklistCsv(out, 37448)).toBe("node.exe");
    expect(parseTasklistCsv('"Serato DJ Pro.exe","812","Console","1","412,004 K"\r\n', 812)).toBe(
      "Serato DJ Pro.exe",
    );
  });

  // With no match tasklist exits 0 and prints a sentence, in the language of
  // the Windows installation -- so it is never matched as text.
  it("returns null when tasklist found no such process, in any language", () => {
    expect(
      parseTasklistCsv("INFO: No tasks are running which match the specified criteria.\r\n", 5),
    ).toBeNull();
    // Not a quoted record either, whatever the words are.
    expect(parseTasklistCsv("INFORMATION: keine Aufgaben gefunden.\r\n", 5)).toBeNull();
    expect(parseTasklistCsv("", 5)).toBeNull();
  });

  it("returns null for a record that is about another pid", () => {
    expect(parseTasklistCsv('"node.exe","37448","Console","1","59,800 K"\r\n', 3744)).toBeNull();
  });
});

describe("createSystemProbe", () => {
  it("names processes by the host's own rule", () => {
    expect(createSystemProbe("win32").isNamed).toBe(isNamedOnWindows);
    expect(createSystemProbe("darwin").isNamed).toBe(isNamedOnPosix);
    expect(createSystemProbe("linux").isNamed).toBe(isNamedOnPosix);
  });
});

describe("systemProbe", () => {
  // EPERM from kill(pid, 0) means a live process owned by another user, not
  // a dead one. The current process is the one pid certain to be alive and
  // nameable in every environment.
  it("sees the current process as alive, with a name", () => {
    expect(systemProbe.isAlive(process.pid)).toBe(true);
    expect(systemProbe.nameOf(process.pid)).toEqual(expect.any(String));
  });

  it("sees a pid that cannot exist as dead", () => {
    expect(systemProbe.isAlive(2_147_483_000)).toBe(false);
  });

  // The whole chain on the real host: a lock row naming this very process
  // is found live. On Windows that is tasklist's "node.exe" against a row
  // saying "node", the form a row without the extension would take.
  it("recognises the current process from a lock row that names it", () => {
    const actual = systemProbe.nameOf(process.pid);
    if (actual === null) throw new Error("the current process has no name");
    const bare = basename(actual).replace(/\.exe$/i, "");
    const rows = [{ owner_process_id: process.pid, owner_process_name: bare }];
    expect(findLiveSerato(rows, systemProbe)).toEqual({ pid: process.pid, name: bare });
    const other = [{ owner_process_id: process.pid, owner_process_name: "Not This Process" }];
    expect(findLiveSerato(other, systemProbe)).toBeNull();
  });
});

describe("checkSeratoClosed", () => {
  it("reads the lock table from master.sqlite and passes when nothing is live", () => {
    const path = masterWithLock([[73438, "Serato DJ Lite"]]);
    expect(readLockRows(path)).toEqual([
      { owner_process_id: 73438, owner_process_name: "Serato DJ Lite" },
    ]);
    expect(checkSeratoClosed(path, probe({}))).toBeNull();
  });

  it("refuses with serato_running and the owner's identity", () => {
    const path = masterWithLock([[500, "Serato DJ Lite"]]);
    const r = checkSeratoClosed(path, probe({ 500: "Serato DJ Lite" }));
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("serato_running");
      expect(r.error.details).toEqual({
        owner_process_id: 500,
        owner_process_name: "Serato DJ Lite",
      });
    }
  });

  it("passes on a master with no lock rows at all", () => {
    expect(checkSeratoClosed(makeMasterFixture(tmp(), { tracks: [] }), probe({}))).toBeNull();
  });
});
