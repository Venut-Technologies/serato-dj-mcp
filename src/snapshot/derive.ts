import type { DatabaseSync } from "node:sqlite";
import { tonality } from "../read/key.js";

/**
 * Bumped whenever the shape or the contents of the derived tables change.
 * It travels in the snapshot's file name, so a snapshot published by an
 * older build is simply never matched by the reuse fast-path -- and the
 * eviction sweep, which matches on the `snap-<libraryKey>-` prefix, deletes
 * it. Without this a cached pre-upgrade snapshot would be served forever,
 * with no mcp_key in it and every key filter silently empty.
 */
export const DERIVED_VERSION = 1;

/**
 * Computes tonality for every track and stores it in the snapshot.
 *
 * This is the whole reason the snapshot stops being a byte copy. The rules
 * live in read/key.ts (Open Key, Camelot, musical notation, enharmonic
 * aliases); reproducing them as a SQL CASE would duplicate them in a second
 * language, and computing them in JS after the query would break both keyset
 * pagination and the limit ceilings.
 *
 * Only tracks that actually have a key get a row: a missing row means "no
 * key", which a LEFT JOIN reports as NULL. A row with NULL columns would be a
 * second way of saying the same thing.
 */
export function buildDerived(db: DatabaseSync): void {
  // DELETE, not the WAL mode inherited from master.sqlite: with WAL our
  // inserts would live in a -wal sidecar, and the publish step deletes
  // sidecars before renaming the file into place. Verified 2026-09-07 that
  // the published file then had an empty mcp_key.
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_key (
    asset_id INTEGER PRIMARY KEY,
    camelot TEXT NOT NULL,
    number INTEGER NOT NULL,
    letter TEXT NOT NULL,
    source TEXT NOT NULL
  )`);

  const columns = new Set(
    (db.prepare("PRAGMA table_info('asset')").all() as { name: string }[]).map((r) => r.name),
  );
  // Schema drift is expected (51 migrations in Serato's own history, spec
  // 3.3): an asset table without these columns is not an error, it just
  // yields no keys.
  if (!columns.has("id")) return;
  const keyValue = columns.has("key_value") ? "key_value" : "NULL AS key_value";
  const keyText = columns.has("key") ? "key" : "NULL AS key";

  const rows = db.prepare(`SELECT id, ${keyValue}, ${keyText} FROM asset`).all() as {
    id: number;
    key_value: unknown;
    key: unknown;
  }[];

  const insert = db.prepare(
    "INSERT OR REPLACE INTO mcp_key (asset_id, camelot, number, letter, source) VALUES (?,?,?,?,?)",
  );
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const t = tonality(row.key_value, row.key);
      if (t === null) continue;
      // "10B" -> number 10, letter "B". parseInt stops at the letter.
      insert.run(row.id, t.camelot, Number.parseInt(t.camelot, 10), t.camelot.slice(-1), t.source);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
