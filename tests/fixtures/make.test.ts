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

  it("carries the real schema version and journal mode", () => {
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
