import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { makeMasterFixture } from "./make.js";

describe("synthetic master fixture", () => {
  let dbPath: string;
  beforeAll(() => {
    dbPath = makeMasterFixture(mkdtempSync(join(tmpdir(), "serato-fx-")), {
      tracks: [
        {
          externalId: 1,
          portableId: "Users/x/a.flac",
          name: "Track A",
          artist: "A",
          bpm: 124,
          keyValue: 21,
        },
        { externalId: 2, portableId: "Users/x/b.flac", name: "Track B", bpm: null, keyValue: -1 },
      ],
    });
  });

  // Journal mode is deliberately NOT asserted here: node:sqlite creates a
  // fresh database in journal_mode=delete, and this fixture never switches
  // it to wal, so it does not carry the real master.sqlite's mode (wal).
  // A test titled "... and journal mode" earlier in this project
  // asserted nothing of the kind and stayed green regardless -- that title
  // is the trap this comment exists to avoid repeating.
  it("carries the real schema version", () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      202,
    );
    db.close();
  });

  // The four triggers that call serato_str_norm and
  // serato_raw_key_string_to_key_type are dropped: those functions are
  // registered by the Serato binary at runtime and do not exist for any
  // other process, so an INSERT would fail with "no such function".
  it("drops exactly the triggers that call Serato runtime functions", () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).not.toContain("after_asset_insert");
    expect(names).not.toContain("after_asset_update");
    expect(names).not.toContain("after_history_entry_insert");
    expect(names).not.toContain("after_history_entry_update");
    expect(names).toContain("before_container_name_update");
    db.close();
  });

  it("seeds a resolvable location, connection and assets", () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const uri = (
      db.prepare("SELECT database_uri FROM connection").get() as { database_uri: string }
    ).database_uri;
    expect(uri.endsWith("root.sqlite")).toBe(true);
    const rows = db
      .prepare("SELECT external_id, name, bpm, key_value FROM asset ORDER BY external_id")
      .all();
    expect(rows).toHaveLength(2);
    expect((rows[0] as { name: string }).name).toBe("Track A");
    expect((rows[1] as { bpm: number | null }).bpm).toBeNull();
    db.close();
  });
});

describe("crate seeding", () => {
  it("builds a crate whose tracks are reachable the way Serato reaches them", () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-fx-"));
    const path = makeMasterFixture(dir, {
      tracks: [
        { externalId: 1, portableId: "Users/x/a.flac", name: "A" },
        { externalId: 2, portableId: "Users/x/b.flac", name: "B" },
        { externalId: 3, portableId: "Users/x/c.flac", name: "C" },
      ],
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [1, 3] }],
    });
    const db = new DatabaseSync(path, { readOnly: true });
    // The join Serato itself uses: container -> location_container ->
    // container_asset. COUNT(DISTINCT) because location_container is 1:N --
    // measured on container 15 of the real library, which has two rows.
    const rows = db
      .prepare(
        `SELECT c.name, count(DISTINCT ca.asset_id) AS n
           FROM container c
           JOIN location_container lc ON lc.container_id = c.id
           JOIN container_asset ca ON ca.location_container_id = lc.id
          WHERE c.type = 1
          GROUP BY c.id, c.name`,
      )
      .all() as { name: string; n: number }[];
    db.close();
    expect(rows).toEqual([{ name: "Gigs 2026", n: 2 }]);
  });

  it("puts the crate under the Serato Library space root, as the real one is", () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-fx-"));
    const path = makeMasterFixture(dir, {
      tracks: [],
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [] }],
    });
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db
      .prepare(
        `SELECT c.parent_id, s.name AS space
           FROM container c JOIN space s ON s.id = c.space_id
          WHERE c.id = 20`,
      )
      .get() as { parent_id: number; space: string };
    db.close();
    expect(row).toEqual({ parent_id: 5, space: "Serato Library" });
  });

  it("seeds the flag columns a filter has to be able to see", () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-fx-"));
    const path = makeMasterFixture(dir, {
      tracks: [
        {
          externalId: 1,
          portableId: "Users/x/a.flac",
          name: "A",
          album: "Album",
          comments: "peak time",
          // asset.rating has CHECK (rating IS NULL OR rating BETWEEN 0 AND
          // 1) in the real schema (tests/fixtures/schema/master-202.sql) --
          // 0.8 stands in for "4 of 5 stars"; a literal 4 fails the CHECK.
          // Verified 2026-09-07 against the dumped DDL.
          rating: 0.8,
          lengthMs: 321_000,
          isMissing: 1,
          isStale: 1,
          thirdPartyType: 2,
          analysisFlags: 24,
        },
      ],
    });
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db
      .prepare(
        "SELECT album, comments, rating, length_ms, is_missing, is_stale, third_party_type, analysis_flags FROM asset",
      )
      .get();
    db.close();
    expect(row).toEqual({
      album: "Album",
      comments: "peak time",
      rating: 0.8,
      length_ms: 321_000,
      is_missing: 1,
      is_stale: 1,
      third_party_type: 2,
      analysis_flags: 24,
    });
  });

  it("fills the *_norm columns the dropped trigger would have filled", () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-fx-"));
    const path = makeMasterFixture(dir, {
      tracks: [
        { externalId: 1, portableId: "Users/x/a.flac", name: "Hey You!", artist: "Kerri Chandler" },
      ],
    });
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT name_norm, artist_norm FROM asset").get();
    db.close();
    expect(row).toEqual({ name_norm: "hey you!", artist_norm: "kerri chandler" });
  });
});
