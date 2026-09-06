import type { DatabaseSync } from "node:sqlite";

/** Schema versions seen on a real install. 202 = Serato DJ Lite 4.0.9. */
export const KNOWN_USER_VERSIONS: readonly number[] = [202];

/**
 * API field -> candidate columns, best first. Serato changes the schema
 * between minor releases (51 migrations in migration_script), so every read
 * picks from what PRAGMA table_info actually reports rather than assuming.
 *
 * length_ms leads because length_sec was NULL on all 19 tracks of the demo
 * library while length_ms was populated. Measured 2026-09-03.
 *
 * `key` is the one field whose candidates are not alternatives: both columns
 * are read, because neither alone covers the library (spec 2.6 -- key_value
 * alone reaches 39 of 118 tracks, both together 114). See read/key.ts, which
 * owns that rule; KEY_COLUMNS there is this entry.
 */
export const ASSET_FIELD_COLUMNS: Record<string, readonly string[]> = {
  id: ["id"],
  title: ["name"],
  artist: ["artist"],
  album: ["album"],
  genre: ["genre"],
  bpm: ["bpm"],
  key: ["key_value", "key"],
  length: ["length_ms", "length_sec"],
  rating: ["rating"],
  added: ["time_added"],
  missing: ["is_missing"],
  streaming: ["third_party_type"],
  play_count: ["dj_play_count"],
  path: ["portable_id"],
};

export type SchemaInfo = {
  userVersion: number;
  known: boolean;
  tables: Set<string>;
  assetColumns: Set<string>;
};

export function introspect(db: DatabaseSync): SchemaInfo {
  const userVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name),
  );
  const assetColumns = new Set(
    tables.has("asset")
      ? (db.prepare("PRAGMA table_info('asset')").all() as { name: string }[]).map((r) => r.name)
      : [],
  );
  return { userVersion, known: KNOWN_USER_VERSIONS.includes(userVersion), tables, assetColumns };
}

export function pickColumns(available: Set<string>, candidates: readonly string[]): string[] {
  return candidates.filter((c) => available.has(c));
}
