import type { DatabaseSync } from "node:sqlite";
import { KEY_COLUMNS, tonality } from "../read/key.js";

/**
 * Bumped whenever the shape or the contents of the derived tables change --
 * INCLUDING a change to the conversion rules in read/key.ts, which decide
 * what goes in the table even though they live somewhere else. There is a
 * pointer back to this constant there, and a golden test over mcp_key's
 * contents in tests/snapshot-derive.test.ts that fails if the rules move
 * without the version moving with them.
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
  // DROP then CREATE, not CREATE IF NOT EXISTS: with IF NOT EXISTS, a source
  // that already had a table of this name would keep ITS shape, the prepared
  // INSERT below would fail on unknown columns, and the throw would surface
  // as snapshot_failed for every read of that library, forever -- the exact
  // opposite of spec 3.3's "an unfamiliar schema warns and degrades". The
  // mcp_ prefix makes a collision with a future Serato table unlikely, but
  // this is a copy we own outright, so owning the table is free.
  db.exec("DROP TABLE IF EXISTS mcp_key");
  db.exec(`CREATE TABLE mcp_key (
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
  // KEY_COLUMNS, not two string literals: read/key.ts owns which columns
  // hold a key, and this is the only place that reads them.
  const [valueColumn, textColumn] = KEY_COLUMNS;
  const keyValue = columns.has(valueColumn) ? valueColumn : `NULL AS ${valueColumn}`;
  const keyText = columns.has(textColumn) ? textColumn : `NULL AS ${textColumn}`;

  const rows = db.prepare(`SELECT id, ${keyValue}, ${keyText} FROM asset`).all() as {
    id: number;
    key_value: unknown;
    key: unknown;
  }[];

  const insert = db.prepare(
    "INSERT INTO mcp_key (asset_id, camelot, number, letter, source) VALUES (?,?,?,?,?)",
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
