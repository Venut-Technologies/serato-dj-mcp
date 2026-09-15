import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  checkSeratoClosed,
  findLiveSerato,
  type ProcessProbe,
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
});

describe("systemProbe", () => {
  // EPERM from kill(pid, 0) means a live process owned by another user, not a
  // dead one (spec 2.7). The current process is the one pid certain to be
  // alive and nameable in every environment.
  it("sees the current process as alive, with a name", () => {
    expect(systemProbe.isAlive(process.pid)).toBe(true);
    expect(systemProbe.nameOf(process.pid)).toEqual(expect.any(String));
  });

  it("sees a pid that cannot exist as dead", () => {
    expect(systemProbe.isAlive(2_147_483_000)).toBe(false);
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
