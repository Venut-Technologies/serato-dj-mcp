import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { getCrateTracks } from "../../src/tools/get-crate-tracks.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-gct-"));

/**
 * Opens the fixture writable so a test can build topology beyond what
 * makeMasterFixture's seed API covers (a second location_container row for
 * a crate that already contains the asset), then closes before the caller
 * reopens the file read-only. Mirrors withWritableDb in
 * tests/read/crates.test.ts, which exercises the same fan-out for
 * listCrates's track_count.
 */
function withWritableDb(path: string, mutate: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    mutate(db);
  } finally {
    db.close();
  }
}

function ctx() {
  const dir = tmp();
  makeMasterFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "First" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "Second" },
      { externalId: 3, portableId: "Users/x/3.flac", name: "Third" },
      { externalId: 4, portableId: "Users/x/4.flac", name: "Not in the crate" },
    ],
    // Seeded in this order on purpose: the crate's own order is 3, 1, 2 and
    // must survive, because it is the DJ's running order.
    crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [3, 1, 2] }],
  });
  return { library: dir, roots: [], cacheDir: tmp() };
}

describe("get_crate_tracks", () => {
  it("returns the crate and its tracks in the crate's own order", async () => {
    const r = await getCrateTracks({ crate_name: "Gigs 2026" }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.crate).toMatchObject({ id: 20, name: "Gigs 2026", track_count: 3 });
    expect(r.tracks.map((t) => t.title)).toEqual(["Third", "First", "Second"]);
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);
  });

  it("takes the crate by id as well", async () => {
    const r = await getCrateTracks({ crate_id: 20 }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.tracks).toHaveLength(3);
  });

  it("refuses both references at once and neither", async () => {
    const both = await getCrateTracks({ crate_id: 20, crate_name: "Gigs 2026" }, ctx());
    expect(isSeratoError(both)).toBe(true);
    if (isSeratoError(both)) expect(both.error.details?.reason).toBe("crate_ref_conflict");

    const neither = await getCrateTracks({}, ctx());
    expect(isSeratoError(neither)).toBe(true);
    if (isSeratoError(neither)) expect(neither.error.details?.reason).toBe("crate_ref_missing");
  });

  it("pages through the crate without repeating a track", async () => {
    const c = ctx();
    const first = await getCrateTracks({ crate_id: 20, limit: 2 }, c);
    if (isSeratoError(first)) throw new Error("unexpected error");
    expect(first.tracks.map((t) => t.title)).toEqual(["Third", "First"]);

    const second = await getCrateTracks({ crate_id: 20, limit: 2, cursor: first.next_cursor }, c);
    if (isSeratoError(second)) throw new Error("unexpected error");
    expect(second.tracks.map((t) => t.title)).toEqual(["Second"]);
    expect(second.next_cursor).toBeUndefined();
  });

  it("returns an empty track list for an empty crate, not an error", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: [],
      crates: [{ id: 21, name: "Empty", trackExternalIds: [] }],
    });
    const r = await getCrateTracks({ crate_id: 21 }, { library: dir, roots: [], cacheDir: tmp() });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.tracks).toEqual([]);
    expect(r.crate.track_count).toBe(0);
  });

  // makeMasterFixture seeds exactly one location_container row per crate, so
  // every test above passes just as well without the GROUP BY / min(list_order)
  // in the query as with it -- nothing exercises the join this task's own
  // code comment names as its reason (container 15 of the real library,
  // measured 2026-09-06). This adds a second location_container row for the
  // same crate and routes track B -- already in the crate -- through it too,
  // with a lower list_order than either existing row, so a regression to a
  // plain (non-grouped) query would both list B twice AND report the wrong
  // position for it.
  it("lists a track once, at its lowest list_order, even when reachable through two locations", async () => {
    const dir = tmp();
    const lib = makeMasterFixture(dir, {
      tracks: [
        { externalId: 1, portableId: "Users/x/1.flac", name: "A" },
        { externalId: 2, portableId: "Users/x/2.flac", name: "B" },
      ],
      // list_order 1 for A, 2 for B via this seed.
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [1, 2] }],
    });

    withWritableDb(lib, (wdb) => {
      const assetB = wdb.prepare("SELECT id FROM asset WHERE external_id = 2").get() as {
        id: number;
      };
      const spaceAssetB = wdb
        .prepare("SELECT id FROM space_asset WHERE asset_id = ?")
        .get(assetB.id) as { id: number };
      const newLocationId = Number(
        wdb.prepare("INSERT INTO location (path, uuid, revision) VALUES (NULL, NULL, 0)").run()
          .lastInsertRowid,
      );
      const newLocationContainerId = Number(
        wdb
          .prepare("INSERT INTO location_container (container_id, location_id) VALUES (20, ?)")
          .run(newLocationId).lastInsertRowid,
      );
      // list_order 0: lower than both existing rows (1 and 2), so min()
      // should move B ahead of A if the grouping is doing its job.
      wdb
        .prepare(
          "INSERT INTO container_asset (asset_id, location_container_id, space_asset_id, list_order) VALUES (?, ?, ?, 0)",
        )
        .run(assetB.id, newLocationContainerId, spaceAssetB.id);
    });

    const r = await getCrateTracks({ crate_id: 20 }, { library: dir, roots: [], cacheDir: tmp() });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.tracks.map((t) => t.title)).toEqual(["B", "A"]);
    expect(r.tracks.filter((t) => t.title === "B")).toHaveLength(1);
  });
});
