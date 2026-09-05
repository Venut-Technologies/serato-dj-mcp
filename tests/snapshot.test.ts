import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../src/errors.js";
import { stalenessKey, takeSnapshot } from "../src/snapshot/index.js";
import { makeMasterFixture } from "./fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-snap-"));

describe("snapshot", () => {
  it("copies a readable, integral database and reads rows from it", async () => {
    const live = makeMasterFixture(tmp(), {
      tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }],
    });
    const snap = await takeSnapshot(live, tmp());
    expect(isSeratoError(snap)).toBe(false);
    if (isSeratoError(snap)) return;

    expect(existsSync(snap.path)).toBe(true);
    const db = new DatabaseSync(snap.path, { readOnly: true });
    expect(
      (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
    ).toBe("ok");
    expect((db.prepare("SELECT count(*) AS n FROM asset").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("gives a stable generation for an unchanged source and a new one after a write", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });
    const cache = tmp();

    const a = await takeSnapshot(live, cache);
    const b = await takeSnapshot(live, cache);
    if (isSeratoError(a) || isSeratoError(b)) throw new Error("unexpected error");
    expect(a.generation).toBe(b.generation);

    const w = new DatabaseSync(live);
    w.prepare(
      "INSERT INTO asset (location_id, external_id, portable_id, file_name, name) VALUES (2,99,'Users/x/z.flac','z.flac','Z')",
    ).run();
    w.close();

    const c = await takeSnapshot(live, cache);
    if (isSeratoError(c)) throw new Error("unexpected error");
    expect(c.generation).not.toBe(a.generation);
  });

  // Measured 2026-09-03: a read-only read of a live WAL database updates the
  // mtime of -shm but never that of the main file or -wal. If the staleness
  // key covered -shm, every query would invalidate its own snapshot.
  it("keys staleness off the main file and -wal only, so reads do not invalidate it", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });

    // makeMasterFixture leaves journal_mode=delete, which never puts a -wal
    // or -shm file on disk at all -- switching to WAL and writing through a
    // still-open connection (mirroring a live Serato process) is what
    // actually gives the main file a -wal sidecar for the read below to
    // leave alone. Closing that connection first would auto-checkpoint and
    // delete it before the read ever runs.
    const writer = new DatabaseSync(live);
    writer.exec("PRAGMA journal_mode = WAL");
    writer
      .prepare(
        "INSERT INTO asset (location_id, external_id, portable_id, file_name, name) VALUES (2,1,'Users/x/a.flac','a.flac','A')",
      )
      .run();

    // Verified empirically (2026-09-06): a read from the SAME process
    // reuses an already-validated wal-index and never rewrites -shm's bytes
    // at all, so a same-process read here would pass whether or not
    // stalenessKey correctly excludes -shm -- exactly the vacuous case this
    // test was rewritten to close. The rewrite only happens when the reader
    // is a genuinely different process from the writer, which is our real
    // setup (this server reads while Serato writes), so the read under test
    // runs in a child process.
    const reader = join(dir, "reader.mjs");
    writeFileSync(
      reader,
      'import { DatabaseSync } from "node:sqlite";\n' +
        "const db = new DatabaseSync(process.argv[2], { readOnly: true });\n" +
        'db.prepare("SELECT count(*) FROM asset").get();\n' +
        "db.close();\n",
    );
    const runReader = () => execFileSync(process.execPath, [reader, live], { stdio: "ignore" });

    // Warm-up: the first cross-process read after the write establishes
    // this reader's mark. It is the read immediately after that mark exists
    // which rewrites -shm again; that is the one under test below.
    runReader();

    const shmBefore = readFileSync(`${live}-shm`);
    const before = stalenessKey(live);

    runReader();

    // Sanity check: if that read did not actually rewrite -shm, the
    // assertion below would pass whether or not stalenessKey correctly
    // excludes it.
    expect(readFileSync(`${live}-shm`).equals(shmBefore)).toBe(false);
    expect(stalenessKey(live)).toBe(before);

    writer.close();
  });

  it("returns snapshot_failed rather than throwing when the source is not a database, and never publishes a poisoned cache entry", async () => {
    const dir = tmp();
    const bogus = join(dir, "master.sqlite");
    writeFileSync(bogus, "this is not sqlite");
    const cache = tmp();

    const r = await takeSnapshot(bogus, cache);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("snapshot_failed");

    // A failed backup must not leave a file at the final name: if it did,
    // the reuse fast-path would serve that truncated file as a valid
    // snapshot on this second call instead of failing again.
    const again = await takeSnapshot(bogus, cache);
    expect(isSeratoError(again)).toBe(true);
    if (isSeratoError(again)) expect(again.error.code).toBe("snapshot_failed");
  });

  it("returns library_not_found, not permission_denied, when the source file does not exist", async () => {
    const dir = tmp();
    const missing = join(dir, "does-not-exist.sqlite");
    const r = await takeSnapshot(missing, tmp());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("library_not_found");
      expect(r.error.details?.searched).toEqual([missing]);
    }
  });

  it("returns permission_denied when the source exists but cannot be opened", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });
    chmodSync(live, 0o000);
    const r = await takeSnapshot(live, tmp());
    chmodSync(live, 0o644);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("permission_denied");
  });
});
