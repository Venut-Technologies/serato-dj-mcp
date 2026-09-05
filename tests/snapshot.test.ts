import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const live = makeMasterFixture(tmp(), { tracks: [] });
    const before = stalenessKey(live);
    const db = new DatabaseSync(live, { readOnly: true });
    db.prepare("SELECT count(*) FROM asset").get();
    db.close();
    expect(stalenessKey(live)).toBe(before);
  });

  it("returns snapshot_failed rather than throwing when the source is not a database", async () => {
    const dir = tmp();
    const bogus = join(dir, "master.sqlite");
    writeFileSync(bogus, "this is not sqlite");
    const r = await takeSnapshot(bogus, tmp());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("snapshot_failed");
  });

  it("returns permission_denied when the source cannot be opened", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });
    chmodSync(live, 0o000);
    const r = await takeSnapshot(live, tmp());
    chmodSync(live, 0o644);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("permission_denied");
  });
});
