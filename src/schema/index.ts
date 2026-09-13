import type { DatabaseSync } from "node:sqlite";

/** Schema versions seen on a real install. 202 = Serato DJ Lite 4.0.9. */
export const KNOWN_USER_VERSIONS: readonly number[] = [202];

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
