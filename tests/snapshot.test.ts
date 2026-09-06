import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

  // throttleMs: 0 because this test writes and immediately re-snapshots,
  // which is precisely what the 2 s throttle exists to coalesce. With the
  // default window the third call would legitimately serve the pre-write
  // copy; here the question is whether a *changed* source yields a new
  // generation at all, so the window is switched off rather than waited out.
  it("gives a stable generation for an unchanged source and a new one after a write", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });
    const cache = tmp();

    const a = await takeSnapshot(live, cache, { throttleMs: 0 });
    const b = await takeSnapshot(live, cache, { throttleMs: 0 });
    if (isSeratoError(a) || isSeratoError(b)) throw new Error("unexpected error");
    expect(a.generation).toBe(b.generation);

    const w = new DatabaseSync(live);
    w.prepare(
      "INSERT INTO asset (location_id, external_id, portable_id, file_name, name) VALUES (2,99,'Users/x/z.flac','z.flac','Z')",
    ).run();
    w.close();

    const c = await takeSnapshot(live, cache, { throttleMs: 0 });
    if (isSeratoError(c)) throw new Error("unexpected error");
    expect(c.generation).not.toBe(a.generation);
  });

  // Regression for a real bug: the temp file both calls back up into used to
  // be named from generation + pid + Date.now() alone, so two concurrent
  // calls for the same generation could compute the identical temp path and
  // race each other's backup(). Measured 2026-09-06: about 40% of 20
  // concurrent pairs then failed with "database is locked" or a disk I/O
  // error.
  it("lets two concurrent calls for the same source both succeed", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });
    const cache = tmp();

    const [a, b] = await Promise.all([takeSnapshot(live, cache), takeSnapshot(live, cache)]);
    expect(isSeratoError(a)).toBe(false);
    expect(isSeratoError(b)).toBe(false);
    if (isSeratoError(a) || isSeratoError(b)) return;
    expect(a.path).toBe(b.path);
    expect(existsSync(a.path)).toBe(true);
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

  // mkdirSync(cacheDir, { recursive: true }) used to sit before any try, so
  // a cacheDir that cannot be created (e.g. a path component that is
  // actually a regular file, giving ENOTDIR) threw a raw Error out of
  // takeSnapshot instead of returning a SeratoError, breaking the "errors
  // are values" contract in src/errors.ts.
  it("returns snapshot_failed instead of throwing when cacheDir cannot be created", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });

    const notADir = join(dir, "not-a-dir");
    writeFileSync(notADir, "x");
    const cache = join(notADir, "cache");

    const r = await takeSnapshot(live, cache);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("snapshot_failed");
      expect(r.error.message).toContain(cache);
    }
  });
});

describe("snapshot cache", () => {
  const insert = (live: string, id: number) => {
    const w = new DatabaseSync(live);
    w.prepare(
      `INSERT INTO asset (location_id, external_id, portable_id, file_name, name) VALUES (2,${id},'Users/x/${id}.flac','${id}.flac','T')`,
    ).run();
    w.close();
  };
  const snapshots = (cache: string) => readdirSync(cache).filter((n) => n.startsWith("snap-"));

  // Spec 7: "снапшоты -- до смены (mtime, size)". Without this a running
  // Serato leaves one full copy of the library per write burst: 4.6 MB each
  // on a 19-track demo library, and P2 makes every read tool a caller.
  it("keeps only the current generation of a library", async () => {
    const live = makeMasterFixture(tmp(), { tracks: [] });
    const cache = tmp();

    const a = await takeSnapshot(live, cache, { throttleMs: 0 });
    insert(live, 1);
    const b = await takeSnapshot(live, cache, { throttleMs: 0 });
    if (isSeratoError(a) || isSeratoError(b)) throw new Error("unexpected error");

    expect(a.generation).not.toBe(b.generation);
    expect(snapshots(cache)).toEqual([basename(b.path)]);
    expect(existsSync(a.path)).toBe(false);
  });

  // A user with an external drive has several libraries and one cache
  // directory. Evicting by "everything that is not the file I just wrote"
  // would delete the other library's current snapshot on every call.
  it("does not evict another library's snapshot", async () => {
    const cache = tmp();
    const one = makeMasterFixture(tmp(), { tracks: [] });
    const two = makeMasterFixture(tmp(), { tracks: [] });

    const a = await takeSnapshot(one, cache, { throttleMs: 0 });
    insert(two, 7);
    const b = await takeSnapshot(two, cache, { throttleMs: 0 });
    if (isSeratoError(a) || isSeratoError(b)) throw new Error("unexpected error");

    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    expect(snapshots(cache).sort()).toEqual([basename(a.path), basename(b.path)].sort());
  });

  // Spec 3.2. The library changes on every Serato write, so without the
  // window each call copies the whole database again.
  it("serves the last snapshot again within the throttle window", async () => {
    const live = makeMasterFixture(tmp(), { tracks: [] });
    const cache = tmp();

    const a = await takeSnapshot(live, cache);
    insert(live, 3);
    const b = await takeSnapshot(live, cache);
    if (isSeratoError(a) || isSeratoError(b)) throw new Error("unexpected error");

    expect(b.path).toBe(a.path);
    expect(b.generation).toBe(a.generation);
    // The snapshot served is up to 2 s stale, which is the trade the spec
    // makes -- but it is still exactly one file, not a second copy.
    expect(snapshots(cache)).toHaveLength(1);
  });

  // The window must never be able to serve a path that is no longer there:
  // macOS may purge ~/Library/Caches at any moment, and another process may
  // have evicted the entry.
  it("re-takes a snapshot inside the window when the cached file is gone", async () => {
    const live = makeMasterFixture(tmp(), { tracks: [] });
    const cache = tmp();

    const a = await takeSnapshot(live, cache);
    if (isSeratoError(a)) throw new Error("unexpected error");
    rmSync(a.path, { force: true });

    const b = await takeSnapshot(live, cache);
    if (isSeratoError(b)) throw new Error("unexpected error");
    expect(existsSync(b.path)).toBe(true);
  });

  // A process killed mid-backup leaves a library-sized temp file behind.
  // Sweeping by age rather than by name is what keeps a *live* concurrent
  // backup's temp file safe.
  it("sweeps stale temp files but leaves a fresh one alone", async () => {
    const live = makeMasterFixture(tmp(), { tracks: [] });
    const cache = tmp();
    await takeSnapshot(live, cache, { throttleMs: 0 });

    const [stale] = readdirSync(cache).filter((n) => n.startsWith("snap-"));
    const prefix = stale.slice("snap-".length).split("-")[0];
    const old = join(cache, `.tmp-${prefix}-deadbeef-999-old.sqlite`);
    const fresh = join(cache, `.tmp-${prefix}-deadbeef-999-fresh.sqlite`);
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);

    insert(live, 5);
    await takeSnapshot(live, cache, { throttleMs: 0 });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
