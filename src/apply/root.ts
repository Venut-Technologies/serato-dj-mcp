import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";
import { ANCHOR_SPACE_NAME } from "../read/crates.js";

export type Anchors = { spaceId: number; rootContainerId: number };

/** Spec 5.1.1. */
export const REQUIRED_ROOT_TABLES: readonly string[] = [
  "serato",
  "master",
  "space",
  "container",
  "container_asset",
  "space_asset",
  "asset",
];

const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  err("write_refused", message, { reason, rejected_track_ids: [], ...extra });

export function checkRootSchema(root: DatabaseSync): null | SeratoError {
  const tables = new Set(
    (
      root.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  const missing = REQUIRED_ROOT_TABLES.filter((t) => !tables.has(t));
  const seratoColumns = tables.has("serato")
    ? (root.prepare("PRAGMA table_info('serato')").all() as { name: string }[]).map((r) => r.name)
    : [];
  if (missing.length > 0 || !seratoColumns.includes("revision")) {
    return refuse(
      "root_schema_unsupported",
      "root.sqlite does not have the schema this protocol writes",
      {
        missing_tables: missing,
        serato_has_revision: seratoColumns.includes("revision"),
      },
    );
  }
  return null;
}

/**
 * Spec 5.2, both queries Serato's own. The space by name (space is UNIQUE on
 * name COLLATE NOCASE, so 0 or 1 rows); the root container by parent_id = 0,
 * never by name -- its name is generated as "<space> root", and UNIQUE
 * (parent_id, name, type) does not stop a user crate of that name at another
 * type.
 */
export function findAnchors(root: DatabaseSync): Anchors | SeratoError {
  const spaces = root
    .prepare("SELECT id FROM space WHERE name = ? COLLATE NOCASE")
    .all(ANCHOR_SPACE_NAME) as { id: number }[];
  if (spaces.length !== 1) {
    return refuse("anchor_space_missing", `root.sqlite has no "${ANCHOR_SPACE_NAME}" space`, {
      found: spaces.length,
    });
  }
  const containers = root
    .prepare(
      "SELECT c.id FROM space s JOIN container c ON s.id = c.space_id WHERE s.id = ? AND c.parent_id = 0",
    )
    .all(spaces[0].id) as { id: number }[];
  if (containers.length !== 1) {
    return refuse(
      "anchor_container_ambiguous",
      "the space's root container is not exactly one row",
      {
        found: containers.length,
      },
    );
  }
  return { spaceId: spaces[0].id, rootContainerId: containers[0].id };
}

/**
 * Spec 5.3: portable_id -> root.asset.id (unique index on portable_id COLLATE
 * NOCASE, so this is one index probe per track) -> space_asset.id by
 * (asset_id, space_id). A track without that space_asset row is unresolvable:
 * v1 never creates asset or space_asset rows (spec 2.4, 5.9).
 */
export function resolveSpaceAssets(
  root: DatabaseSync,
  spaceId: number,
  portableIds: readonly string[],
): { resolved: Map<string, number>; missing: string[] } {
  const stmt = root.prepare(
    `SELECT sa.id FROM asset a JOIN space_asset sa ON sa.asset_id = a.id
      WHERE a.portable_id = ? COLLATE NOCASE AND sa.space_id = ?`,
  );
  const resolved = new Map<string, number>();
  const missing: string[] = [];
  for (const portableId of portableIds) {
    const row = stmt.get(portableId, spaceId) as { id: number } | undefined;
    if (row === undefined) missing.push(portableId);
    else resolved.set(portableId, row.id);
  }
  return { resolved, missing };
}

/** Folds case the way container's UNIQUE(parent_id, name COLLATE NOCASE,
 *  type) does -- measured on a copy: 'sErAtO dEmO tRaCkS' collides with
 *  'Serato Demo Tracks' (spec 5.4). */
export function existingCrateId(
  root: DatabaseSync,
  rootContainerId: number,
  name: string,
): number | null {
  const row = root
    .prepare(
      "SELECT id FROM container WHERE parent_id = ? AND name = ? COLLATE NOCASE AND type = 1",
    )
    .get(rootContainerId, name) as { id: number } | undefined;
  return row === undefined ? null : row.id;
}

/**
 * Spec 3.4. Informational since P4 amendment 2: apply re-validates what the
 * crate depends on instead of refusing on this value, and reports a change as
 * a warning. Reads serato.revision only -- never the master table, whose
 * last_sync_secret does not fit a JavaScript number (measured 2026-09-14).
 */
export function rootGeneration(root: DatabaseSync, rootPath: string, libraryId: string): string {
  const { revision } = root.prepare("SELECT revision FROM serato").get() as { revision: number };
  const st = statSync(rootPath);
  return createHash("sha256")
    .update(`${libraryId}|${revision}|${st.mtimeMs}|${st.size}`)
    .digest("hex")
    .slice(0, 12);
}
