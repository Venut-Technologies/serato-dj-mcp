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
  /** The text `key` column. Serato leaves it filled even when its own parser
   *  gives up and writes -1 into key_value -- 75 of 118 real tracks, measured
   *  2026-09-06. */
  keyText?: string;
  genre?: string;
  timeAdded?: number;
  isMissing?: number;
  thirdPartyType?: number;
  analysisFlags?: number;
  album?: string;
  comments?: string;
  rating?: number | null;
  lengthMs?: number | null;
  isStale?: number;
  fileSize?: number | null;
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

/** The Serato Library space and its root container, as they are numbered in
 *  the real master.sqlite (measured 2026-09-06). Every crate hangs off this
 *  root, which is how Serato itself lays them out. */
const SPACE_ID = 5;
const SPACE_ROOT_CONTAINER_ID = 5;

export type CrateSeed = {
  id: number;
  name: string;
  /** external_id of each track, not asset.id: the seeds are written with
   *  external_id, and asset.id is assigned by SQLite. */
  trackExternalIds: number[];
};

export function makeMasterFixture(
  dir: string,
  opts: { tracks?: TrackSeed[]; crates?: CrateSeed[]; userVersion?: number } = {},
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

  db.prepare("INSERT INTO space (id, name) VALUES (?, ?)").run(SPACE_ID, "Serato Library");
  // container.list_order is NOT NULL and has no default -- including on the
  // space root, which is easy to miss because Serato's own root looks empty.
  db.prepare(
    "INSERT INTO container (id, parent_id, name, type, space_id, list_order) VALUES (?, NULL, ?, 0, ?, 0)",
  ).run(SPACE_ROOT_CONTAINER_ID, "Serato Library root", SPACE_ID);

  // external_id and location_id are the only NOT NULL columns of asset
  // without a default. Measured 2026-09-03.
  //
  // The *_norm columns are filled here because the trigger that normally
  // fills them (after_asset_insert) calls serato_str_norm, a function only
  // the Serato process has, so the fixture drops it. Lowercasing is what
  // serato_str_norm was observed to do: "Hey You! - Scratch Sample" ->
  // "hey you! - scratch sample" (spec 2.9.1). Without this every _norm is
  // NULL and any test that touches search or text ordering is measuring
  // nothing.
  const ins = db.prepare(
    `INSERT INTO asset (location_id, external_id, portable_id, file_name, name, artist, album,
                        comments, bpm, key_value, key, genre, rating, length_ms, time_added,
                        is_missing, is_stale, third_party_type, analysis_flags, file_size,
                        name_norm, artist_norm, album_norm, genre_norm, comments_norm)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const t of opts.tracks ?? []) {
    ins.run(
      LOCATION_ID,
      t.externalId,
      t.portableId,
      t.portableId.split("/").pop() ?? t.portableId,
      t.name,
      t.artist ?? "",
      t.album ?? "",
      t.comments ?? "",
      t.bpm === undefined ? null : t.bpm,
      t.keyValue ?? -1,
      t.keyText ?? "",
      t.genre ?? "",
      t.rating === undefined ? null : t.rating,
      t.lengthMs === undefined ? null : t.lengthMs,
      t.timeAdded ?? 1_700_000_000,
      t.isMissing ?? 0,
      t.isStale ?? 0,
      t.thirdPartyType ?? 0,
      t.analysisFlags ?? 31,
      t.fileSize === undefined ? null : t.fileSize,
      t.name.toLowerCase(),
      (t.artist ?? "").toLowerCase(),
      (t.album ?? "").toLowerCase(),
      (t.genre ?? "").toLowerCase(),
      (t.comments ?? "").toLowerCase(),
    );
  }

  // One space_asset row per track, exactly as the real library has (118
  // tracks, 118 rows, all in space 5). container_asset.space_asset_id is NOT
  // NULL with a foreign key to this table, and node:sqlite enforces foreign
  // keys by default (verified 2026-09-07), so a crate cannot be seeded
  // without these rows.
  const assets = db
    .prepare("SELECT id, external_id FROM asset WHERE location_id = ? ORDER BY id")
    .all(LOCATION_ID) as { id: number; external_id: number }[];
  const assetIdByExternalId = new Map(assets.map((a) => [a.external_id, a.id]));
  const spaceAssetIdByAssetId = new Map<number, number>();
  let spaceAssetId = 0;
  for (const asset of assets) {
    spaceAssetId += 1;
    db.prepare("INSERT INTO space_asset (id, asset_id, space_id) VALUES (?, ?, ?)").run(
      spaceAssetId,
      asset.id,
      SPACE_ID,
    );
    spaceAssetIdByAssetId.set(asset.id, spaceAssetId);
  }

  let locationContainerId = 0;
  let containerAssetId = 0;
  for (const crate of opts.crates ?? []) {
    db.prepare(
      "INSERT INTO container (id, parent_id, name, type, space_id, list_order) VALUES (?, ?, ?, 1, ?, ?)",
    ).run(crate.id, SPACE_ROOT_CONTAINER_ID, crate.name, SPACE_ID, crate.id);

    locationContainerId += 1;
    db.prepare(
      "INSERT INTO location_container (id, container_id, location_id) VALUES (?, ?, ?)",
    ).run(locationContainerId, crate.id, LOCATION_ID);

    // list_order follows the order the seed lists them in: that is the DJ's
    // running order, and get_crate_tracks is required to preserve it.
    let listOrder = 0;
    for (const externalId of crate.trackExternalIds) {
      const assetId = assetIdByExternalId.get(externalId);
      if (assetId === undefined) {
        throw new Error(`crate ${crate.name} references unknown external_id ${externalId}`);
      }
      // spaceAssetIdByAssetId was populated from the same `assets` array
      // assetId is drawn from, so this always hits -- but node:sqlite's
      // params reject `undefined`, so the lookup is checked rather than
      // asserted non-null.
      const spaceAssetId = spaceAssetIdByAssetId.get(assetId);
      if (spaceAssetId === undefined) {
        throw new Error(`asset ${assetId} has no space_asset row`);
      }
      containerAssetId += 1;
      listOrder += 1;
      db.prepare(
        `INSERT INTO container_asset (id, asset_id, location_container_id, space_asset_id, list_order)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(containerAssetId, assetId, locationContainerId, spaceAssetId, listOrder);
    }
  }

  db.close();
  return path;
}
