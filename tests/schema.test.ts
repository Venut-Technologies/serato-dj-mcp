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

  it("picks only the candidate columns that exist", () => {
    expect(pickColumns(new Set(["a", "c"]), ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(pickColumns(new Set(), ["a"])).toEqual([]);
  });

  // length_sec was NULL on all 19 tracks of the demo library while length_ms
  // was populated, so length_ms leads the candidate list.
  it("prefers length_ms over length_sec for duration", () => {
    expect(ASSET_FIELD_COLUMNS.length[0]).toBe("length_ms");
  });
});
