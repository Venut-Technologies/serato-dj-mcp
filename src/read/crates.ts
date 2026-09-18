import type { DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";

export type Crate = {
  id: number;
  name: string;
  space: string;
  path: string;
  parent_id: number | null;
  type: number;
  track_count: number;
};

/**
 * The one space whose subtree holds user crates. A bare `type = 1` filter is
 * not enough to identify them: Serato's own Prepare panel is also
 * `type = 1`, but it lives in a space of its own (named "Prepare"), not this
 * one -- verified against the live library, which returned
 * `{"id":14,"name":"Prepare","space":"Prepare",...}` for a plain `type = 1`
 * query. The write path anchors on this same space by the same name; the
 * read path has to agree, or a crate the write path would never touch could
 * still be listed and resolved for reads (found in review, 2026-09-13).
 */
export const ANCHOR_SPACE_NAME = "Serato Library";

/**
 * Walks down from the anchor space's root, carrying the space name and
 * building the display path.
 *
 * The synthetic root (id 0) is excluded by the JOIN: it is the only
 * type = 0 container with space_id NULL. Without that exclusion every crate
 * would appear twice -- once under its space and once under "root". Every
 * other space -- the internal ones Serato keeps alongside the user's, the
 * Prepare panel among them -- is excluded by the `s.name` filter below.
 *
 * track_count is COUNT(DISTINCT ca.asset_id): location_container is 1:N, so
 * a plain COUNT(*) multiplies a crate's tracks by the number of locations
 * (observed on container 15 of the real library, which has two rows --
 * measured 2026-09-06).
 */
const CRATE_QUERY = `
WITH RECURSIVE chain(id, name, parent_id, type, space, path) AS (
  SELECT c.id, c.name, c.parent_id, c.type, s.name, s.name
    FROM container c JOIN space s ON s.id = c.space_id
   WHERE c.type = 0 AND s.name = ? COLLATE NOCASE
  UNION ALL
  SELECT c.id, c.name, c.parent_id, c.type, chain.space, chain.path || ' / ' || c.name
    FROM container c JOIN chain ON c.parent_id = chain.id
)
SELECT chain.id, chain.name, chain.space, chain.path, chain.parent_id, chain.type,
       (SELECT count(DISTINCT ca.asset_id)
          FROM location_container lc
          JOIN container_asset ca ON ca.location_container_id = lc.id
         WHERE lc.container_id = chain.id) AS track_count
  FROM chain
 WHERE chain.type = 1`;

export function listCrates(db: DatabaseSync, opts: { limit: number; afterId?: number }): Crate[] {
  const after = opts.afterId ?? -1;
  return db
    .prepare(`${CRATE_QUERY} AND chain.id > ? ORDER BY chain.id LIMIT ?`)
    .all(ANCHOR_SPACE_NAME, after, opts.limit) as Crate[];
}

/**
 * Exact match, case-insensitive (decided 2026-09-07): a partial match would
 * silently pick "Gigs 2025" for "Gigs"; the refusal instead carries every
 * crate name, so the model picks correctly on its next call rather than
 * having to list the crates first.
 */
export function resolveCrate(
  db: DatabaseSync,
  ref: { id?: number; name?: string },
): Crate | SeratoError {
  const all = db.prepare(`${CRATE_QUERY} ORDER BY chain.id`).all(ANCHOR_SPACE_NAME) as Crate[];

  if (ref.id !== undefined) {
    const hit = all.find((c) => c.id === ref.id);
    if (hit !== undefined) return hit;
    return err("invalid_argument", `no crate with id ${ref.id}`, {
      reason: "unknown_crate",
      available: all.map((c) => c.name),
    });
  }

  if (ref.name !== undefined) {
    const wanted = ref.name.trim().toLowerCase();
    const hits = all.filter((c) => c.name.toLowerCase() === wanted);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      // Two spaces can hold crates of the same name; the model has to say
      // which by id.
      return err("invalid_argument", `more than one crate is named ${ref.name}`, {
        reason: "ambiguous_crate",
        candidates: hits.map((c) => ({ id: c.id, path: c.path })),
      });
    }
    return err("invalid_argument", `no crate named ${ref.name}`, {
      reason: "unknown_crate",
      available: all.map((c) => c.name),
    });
  }

  return err("invalid_argument", "a crate must be given by id or by name", {
    reason: "crate_ref_missing",
  });
}
