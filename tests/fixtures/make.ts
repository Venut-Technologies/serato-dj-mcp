import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export type TrackSeed = {
  externalId: number;
  portableId: string;
  name: string;
  artist?: string;
  bpm?: number | null;
  keyValue?: number;
  genre?: string;
  timeAdded?: number;
  isMissing?: number;
  thirdPartyType?: number;
  analysisFlags?: number;
};

/**
 * The four triggers below call serato_str_norm and
 * serato_raw_key_string_to_key_type, which the Serato binary registers on its
 * own connection at runtime. Any INSERT into asset or history_entry from
 * another process fails with "no such function", so a fixture that keeps them
 * cannot be seeded at all. Verified 2026-09-03 against Serato DJ Lite 4.0.9.
 */
const RUNTIME_FUNCTION_TRIGGERS = [
  "after_asset_insert",
  "after_asset_update",
  "after_history_entry_insert",
  "after_history_entry_update",
];

/** Uuid of the boot-disk location, mirrored by root.sqlite's serato_db view. */
const LOCATION_UUID = Buffer.from("22222222222222222222222222222222", "hex");
const LOCATION_ID = 2;

export function makeMasterFixture(
  dir: string,
  opts: { tracks?: TrackSeed[]; userVersion?: number } = {},
): string {
  const path = join(dir, "master.sqlite");
  const db = new DatabaseSync(path);

  // exec() applies the whole DDL in one go. Splitting on ";" would corrupt
  // trigger bodies, which contain semicolons inside BEGIN...END.
  db.exec(readFileSync(join(HERE, "schema", "master-202.sql"), "utf8"));
  for (const t of RUNTIME_FUNCTION_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  db.exec(`PRAGMA user_version = ${opts.userVersion ?? 202}`);

  db.prepare("INSERT INTO location (id, path, uuid, revision) VALUES (?, NULL, ?, 13)").run(
    LOCATION_ID,
    LOCATION_UUID,
  );
  db.prepare("INSERT INTO connection (location_id, database_uri) VALUES (?, ?)").run(
    LOCATION_ID,
    "/Users/x/Library/Application Support/Serato/Library/root.sqlite",
  );

  // external_id and location_id are the only NOT NULL columns of asset
  // without a default. Measured 2026-09-03.
  const ins = db.prepare(
    `INSERT INTO asset (location_id, external_id, portable_id, file_name, name, artist,
                        bpm, key_value, genre, time_added, is_missing, third_party_type,
                        analysis_flags)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const t of opts.tracks ?? []) {
    ins.run(
      LOCATION_ID,
      t.externalId,
      t.portableId,
      t.portableId.split("/").pop() ?? t.portableId,
      t.name,
      t.artist ?? "",
      t.bpm === undefined ? null : t.bpm,
      t.keyValue ?? -1,
      t.genre ?? "",
      t.timeAdded ?? 1_700_000_000,
      t.isMissing ?? 0,
      t.thirdPartyType ?? 0,
      t.analysisFlags ?? 31,
    );
  }

  db.close();
  return path;
}
