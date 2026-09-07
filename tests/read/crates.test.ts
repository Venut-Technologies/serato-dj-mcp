import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { listCrates, resolveCrate } from "../../src/read/crates.js";
import { makeMasterFixture } from "../fixtures/make.js";

function library() {
  const dir = mkdtempSync(join(tmpdir(), "serato-crates-"));
  const path = makeMasterFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "A" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "B" },
      { externalId: 3, portableId: "Users/x/3.flac", name: "C" },
    ],
    crates: [
      { id: 20, name: "Gigs 2026", trackExternalIds: [1, 2] },
      { id: 21, name: "Warmups", trackExternalIds: [] },
    ],
  });
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Opens the fixture writable so a test can build topology beyond what
 * makeMasterFixture's seed API covers (a second space, a nested crate, a
 * second location_container row), then closes before the caller reopens
 * the file read-only. Kept as one small helper here rather than growing
 * makeMasterFixture -- that function is already ~130 lines, and this shape
 * is needed in exactly the three tests below.
 *
 * node:sqlite enforces foreign keys (see tests/fixtures/make.ts), so the
 * mutator must insert in dependency order; ids are left to SQLite's
 * rowid/AUTOINCREMENT assignment (via each run()'s lastInsertRowid) rather
 * than hand-picked, so a caller can never collide with an id the seed API
 * already used.
 */
function withWritableDb(path: string, mutate: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    mutate(db);
  } finally {
    db.close();
  }
}

describe("listCrates", () => {
  const db = library();

  it("lists the crates with their space, path and distinct track count", () => {
    expect(listCrates(db, { limit: 10 })).toEqual([
      {
        id: 20,
        name: "Gigs 2026",
        space: "Serato Library",
        path: "Serato Library / Gigs 2026",
        parent_id: 5,
        type: 1,
        track_count: 2,
      },
      {
        id: 21,
        name: "Warmups",
        space: "Serato Library",
        path: "Serato Library / Warmups",
        parent_id: 5,
        type: 1,
        track_count: 0,
      },
    ]);
  });

  // Decision 5: the 15 space roots and the smart crate (whose real name is
  // "Stems<private-use char>22222222...") are noise in the model's context.
  it("shows no space roots", () => {
    expect(listCrates(db, { limit: 100 }).every((c) => c.type === 1)).toBe(true);
  });

  it("pages by id", () => {
    expect(listCrates(db, { limit: 1 }).map((c) => c.id)).toEqual([20]);
    expect(listCrates(db, { limit: 10, afterId: 20 }).map((c) => c.id)).toEqual([21]);
  });

  // Review 2026-09-07 (finding 2): makeMasterFixture seeds exactly one
  // location_container row per crate, so every test above passes just as
  // well with a plain COUNT(*) as with COUNT(DISTINCT ...) -- nothing here
  // exercised the join this task exists for (see the doc comment on
  // CRATE_QUERY, and container 15 of the real library, measured
  // 2026-09-06). This adds a second location_container row for the same
  // crate -- the UNIQUE constraint is on the pair (container_id,
  // location_id), not on container_id alone -- and routes the SAME asset
  // through it, so a regression to COUNT(*) would report 2 where the
  // correct answer is 1 (confirmed: the plain-COUNT(*) form of this query
  // does return 2 against this exact fixture).
  it("counts a track once even when location_container has two rows for the crate", () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-crates-"));
    const path = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Users/x/1.flac", name: "A" }],
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [1] }],
    });

    withWritableDb(path, (wdb) => {
      const asset = wdb.prepare("SELECT id FROM asset WHERE external_id = 1").get() as {
        id: number;
      };
      const spaceAsset = wdb
        .prepare("SELECT id FROM space_asset WHERE asset_id = ?")
        .get(asset.id) as { id: number };
      const newLocationId = Number(
        wdb.prepare("INSERT INTO location (path, uuid, revision) VALUES (NULL, NULL, 0)").run()
          .lastInsertRowid,
      );
      const newLocationContainerId = Number(
        wdb
          .prepare("INSERT INTO location_container (container_id, location_id) VALUES (20, ?)")
          .run(newLocationId).lastInsertRowid,
      );
      wdb
        .prepare(
          "INSERT INTO container_asset (asset_id, location_container_id, space_asset_id, list_order) VALUES (?, ?, ?, 1)",
        )
        .run(asset.id, newLocationContainerId, spaceAsset.id);
    });

    const db2 = new DatabaseSync(path, { readOnly: true });
    expect(listCrates(db2, { limit: 10 })[0].track_count).toBe(1);
  });

  // Review 2026-09-07 (finding 3): every crate above hangs directly off the
  // space root, so the recursive step of CRATE_QUERY -- a crate whose
  // parent is another crate, not a space root -- was never exercised. This
  // nests a crate under crate 20 and checks it surfaces exactly once, with
  // the full chain in its path.
  it("lists a crate nested under another crate exactly once, with the full path", () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-crates-"));
    const path = makeMasterFixture(dir, {
      tracks: [],
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [] }],
    });

    let childId = 0;
    withWritableDb(path, (wdb) => {
      const parent = wdb.prepare("SELECT space_id FROM container WHERE id = 20").get() as {
        space_id: number;
      };
      childId = Number(
        wdb
          .prepare(
            "INSERT INTO container (parent_id, name, type, space_id, list_order) VALUES (20, ?, 1, ?, 0)",
          )
          .run("Warmup Set", parent.space_id).lastInsertRowid,
      );
    });

    const db2 = new DatabaseSync(path, { readOnly: true });
    const nested = listCrates(db2, { limit: 100 }).filter((c) => c.id === childId);
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatchObject({
      parent_id: 20,
      path: "Serato Library / Gigs 2026 / Warmup Set",
    });
  });
});

describe("resolveCrate", () => {
  const db = library();

  it("finds a crate by id and by name, ignoring case", () => {
    expect(resolveCrate(db, { id: 20 })).toMatchObject({ name: "Gigs 2026" });
    expect(resolveCrate(db, { name: "gigs 2026" })).toMatchObject({ id: 20 });
  });

  // Decision 8: exact match, and the refusal carries the whole list so the
  // model can pick without a second round trip.
  it("refuses a partial name and shows what exists", () => {
    const r = resolveCrate(db, { name: "Gigs" });
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.details?.reason).toBe("unknown_crate");
    expect(r.error.details?.available).toEqual(["Gigs 2026", "Warmups"]);
  });

  it("refuses an unknown id", () => {
    const r = resolveCrate(db, { id: 999 });
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("unknown_crate");
  });

  it("refuses when neither id nor name is given", () => {
    const r = resolveCrate(db, {});
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("crate_ref_missing");
  });

  // Review 2026-09-07 (finding 1): ambiguous_crate is one of the three
  // contract reason strings this task was scoped to deliver, and it had no
  // coverage. Two spaces can each hold a crate of the same name -- the
  // container UNIQUE constraint is (parent_id, name, type), and these two
  // crates have different parents (different space roots), so both inserts
  // succeed.
  it("refuses an ambiguous name and names both candidates by id and path", () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-crates-"));
    const path = makeMasterFixture(dir, {
      tracks: [],
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [] }],
    });

    let secondCrateId = 0;
    withWritableDb(path, (wdb) => {
      const spaceId = Number(
        wdb.prepare("INSERT INTO space (name) VALUES (?)").run("Other Library").lastInsertRowid,
      );
      const rootId = Number(
        wdb
          .prepare(
            "INSERT INTO container (parent_id, name, type, space_id, list_order) VALUES (NULL, ?, 0, ?, 0)",
          )
          .run("Other Library root", spaceId).lastInsertRowid,
      );
      secondCrateId = Number(
        wdb
          .prepare(
            "INSERT INTO container (parent_id, name, type, space_id, list_order) VALUES (?, ?, 1, ?, 0)",
          )
          .run(rootId, "Gigs 2026", spaceId).lastInsertRowid,
      );
    });

    const db2 = new DatabaseSync(path, { readOnly: true });
    const r = resolveCrate(db2, { name: "Gigs 2026" });
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.details?.reason).toBe("ambiguous_crate");
    expect(r.error.details?.candidates).toEqual([
      { id: 20, path: "Serato Library / Gigs 2026" },
      { id: secondCrateId, path: "Other Library / Gigs 2026" },
    ]);
  });
});
