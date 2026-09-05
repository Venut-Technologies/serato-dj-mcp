import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ASSET_FIELD_COLUMNS,
  introspect,
  KNOWN_USER_VERSIONS,
  pickColumns,
} from "../src/schema/index.js";
import { makeMasterFixture } from "./fixtures/make.js";

const open = (uv?: number) =>
  new DatabaseSync(
    makeMasterFixture(mkdtempSync(join(tmpdir(), "serato-schema-")), { userVersion: uv }),
    { readOnly: true },
  );

// Builds on a normal fixture, then removes columns with a real ALTER TABLE so
// the result reflects an actually narrower schema rather than a hand-rolled
// stand-in. Neither column is referenced by any trigger, index, or check
// constraint left standing after makeMasterFixture drops the runtime-function
// triggers, so the DDL succeeds without further surgery.
const openMissingAssetColumns = (columns: readonly string[]) => {
  const path = makeMasterFixture(mkdtempSync(join(tmpdir(), "serato-schema-reduced-")));
  const db = new DatabaseSync(path);
  for (const c of columns) db.exec(`ALTER TABLE asset DROP COLUMN ${c}`);
  db.close();
  return new DatabaseSync(path, { readOnly: true });
};

describe("schema introspection", () => {
  it("reports the schema version and marks 202 as known", () => {
    const db = open();
    const info = introspect(db);
    expect(info.userVersion).toBe(202);
    expect(info.known).toBe(true);
    expect(KNOWN_USER_VERSIONS).toContain(202);
    db.close();
  });

  // Serato ships 51 migrations and bumps the schema between minor releases.
  // An unknown version must warn, never refuse: a server that dies on every
  // Serato update is useless.
  it("marks an unknown version without throwing", () => {
    const db = open(999);
    const info = introspect(db);
    expect(info.userVersion).toBe(999);
    expect(info.known).toBe(false);
    db.close();
  });

  it("collects the tables and asset columns actually present", () => {
    const db = open();
    const info = introspect(db);
    for (const t of ["asset", "container", "container_asset", "location", "connection", "lock"]) {
      expect(info.tables.has(t)).toBe(true);
    }
    for (const c of ["portable_id", "external_id", "key_value", "length_ms", "name_norm"]) {
      expect(info.assetColumns.has(c)).toBe(true);
    }
    db.close();
  });

  // A hardcoded superset would still pass the "present" assertions above.
  // Only a genuinely narrower schema — columns actually dropped from asset —
  // can tell reflection apart from a fixed list.
  it("excludes asset columns that are genuinely absent from the schema", () => {
    const db = openMissingAssetColumns(["key_value", "length_sec"]);
    const info = introspect(db);
    expect(info.assetColumns.has("key_value")).toBe(false);
    expect(info.assetColumns.has("length_sec")).toBe(false);
    for (const c of ["name", "portable_id", "length_ms"]) {
      expect(info.assetColumns.has(c)).toBe(true);
    }
    db.close();
  });

  // Exercises the tables.has("asset") guard in introspect: no asset table at
  // all, not merely one with fewer columns.
  it("reports no tables and no asset columns when the database is empty", () => {
    const db = new DatabaseSync(":memory:");
    const info = introspect(db);
    expect(info.tables.has("asset")).toBe(false);
    expect(info.assetColumns.size).toBe(0);
    db.close();
  });

  it("picks only the candidate columns that exist", () => {
    expect(pickColumns(new Set(["a", "c"]), ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(pickColumns(new Set(), ["a"])).toEqual([]);
  });

  // available iterates as {"c", "a"} — the reverse of the candidate order —
  // so this only passes if pickColumns orders by the candidate list, not by
  // whatever order the available set happens to iterate in.
  it("orders picked columns by the candidate list, not by the available set", () => {
    expect(pickColumns(new Set(["c", "a"]), ["a", "b", "c"])).toEqual(["a", "c"]);
  });

  // length_sec was NULL on all 19 tracks of the demo library while length_ms
  // was populated, so length_ms leads the candidate list.
  it("prefers length_ms over length_sec for duration", () => {
    expect(ASSET_FIELD_COLUMNS.length[0]).toBe("length_ms");
  });
});
