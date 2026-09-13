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

/**
 * The container tree, numbered as the real master.sqlite numbers it
 * (measured 2026-09-06). Getting this shape right in the fixture is not
 * decoration: the whole-branch review of P2 found a defect -- Serato's
 * Prepare panel listed as a user crate -- that no test could express,
 * precisely because the fixture used to seed one space and no synthetic
 * root. Spec 8 names that trap.
 *
 * The real tree is: container 0 is a synthetic root (parent NULL, space
 * NULL), every space root hangs off it at parent_id 0, and user crates hang
 * off their space root. The Prepare panel is a type = 1 container in its own
 * space -- indistinguishable from a user crate by type alone, which is why
 * spec 2.4 says filtering on type = 1 is insufficient, and why the fixture
 * seeds one by default.
 */
const SYNTHETIC_ROOT_CONTAINER_ID = 0;
const SPACE_ID = 5;
const SPACE_ROOT_CONTAINER_ID = 5;
const PREPARE_SPACE_ID = 4;
const PREPARE_ROOT_CONTAINER_ID = 4;
const PREPARE_CONTAINER_ID = 14;

export type CrateSeed = {
  id: number;
  name: string;
  /** external_id of each track, not asset.id: the seeds are written with
   *  external_id, and asset.id is assigned by SQLite. */
  trackExternalIds: number[];
};

export function makeMasterFixture(
  dir: string,
  opts: {
    tracks?: TrackSeed[];
    crates?: CrateSeed[];
    userVersion?: number;
    /** The location's database_uri, which is the ONLY source of a volume
     *  root (location.path is NULL in every observed row, spec 2.3). Default
     *  is the boot disk. Override it to model a library on an external
     *  volume, mounted or not. */
    connectionUri?: string;
    /** Tracks to put into Serato's Prepare panel (container 14, a type = 1
     *  container in its own space). Nothing that reads crates may return
     *  them as crate members -- spec 2.4 -- and that claim needs a fixture
     *  that can express it. */
    prepareTrackExternalIds?: number[];
  } = {},
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
    opts.connectionUri ?? "/Users/x/Library/Application Support/Serato/Library/root.sqlite",
  );

  // container.list_order is NOT NULL and has no default -- including on the
  // roots, which is easy to miss because Serato's own roots look empty.
  const container = db.prepare(
    "INSERT INTO container (id, parent_id, name, type, space_id, list_order) VALUES (?,?,?,?,?,?)",
  );
  const space = db.prepare("INSERT INTO space (id, name) VALUES (?, ?)");

  // The synthetic root: the only type = 0 container with a NULL space_id.
  // The crate query's recursion is anchored to exclude it, and that claim is
  // untestable unless the fixture actually has one.
  container.run(SYNTHETIC_ROOT_CONTAINER_ID, null, "root", 0, null, 0);

  space.run(SPACE_ID, "Serato Library");
  container.run(
    SPACE_ROOT_CONTAINER_ID,
    SYNTHETIC_ROOT_CONTAINER_ID,
    "Serato Library root",
    0,
    SPACE_ID,
    0,
  );

  // The Prepare panel, exactly as the real library carries it: a second
  // space, its root, and a type = 1 container inside it. Nothing that reads
  // crates may return this container -- it is Serato's staging panel, not a
  // crate the DJ made.
  space.run(PREPARE_SPACE_ID, "Prepare");
  container.run(
    PREPARE_ROOT_CONTAINER_ID,
    SYNTHETIC_ROOT_CONTAINER_ID,
    "Prepare root",
    0,
    PREPARE_SPACE_ID,
    0,
  );
  container.run(PREPARE_CONTAINER_ID, PREPARE_ROOT_CONTAINER_ID, "Prepare", 1, PREPARE_SPACE_ID, 0);

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
  const spaceAsset = db.prepare("INSERT INTO space_asset (id, asset_id, space_id) VALUES (?,?,?)");
  const locationContainer = db.prepare(
    "INSERT INTO location_container (id, container_id, location_id) VALUES (?, ?, ?)",
  );
  const containerAsset = db.prepare(
    `INSERT INTO container_asset (id, asset_id, location_container_id, space_asset_id, list_order)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const prepareIds = opts.prepareTrackExternalIds ?? [];
  if (prepareIds.length > 0) {
    locationContainerId += 1;
    locationContainer.run(locationContainerId, PREPARE_CONTAINER_ID, LOCATION_ID);
    const prepareLocationContainerId = locationContainerId;
    let order = 0;
    for (const externalId of prepareIds) {
      const assetId = assetIdByExternalId.get(externalId);
      if (assetId === undefined) {
        throw new Error(`the Prepare panel references unknown external_id ${externalId}`);
      }
      // Its own space_asset row: space_asset is UNIQUE(asset_id, space_id),
      // so a track in two spaces has two.
      spaceAssetId += 1;
      spaceAsset.run(spaceAssetId, assetId, PREPARE_SPACE_ID);
      containerAssetId += 1;
      order += 1;
      containerAsset.run(
        containerAssetId,
        assetId,
        prepareLocationContainerId,
        spaceAssetId,
        order,
      );
    }
  }
  for (const crate of opts.crates ?? []) {
    container.run(crate.id, SPACE_ROOT_CONTAINER_ID, crate.name, 1, SPACE_ID, crate.id);

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
