import type { Warning } from "../envelope.js";
import { err, type SeratoError } from "../errors.js";

/** [is the value NULL (0/1), the value itself, the row id]. The null flag is
 *  part of the key because NULLs sort last: without it `val > NULL` is NULL,
 *  the keyset predicate is never true inside the NULL block, and the second
 *  page starts the listing over. */
export type CursorKey = [number, string | number | null, number];

export type SortSpec = { field: string; dir: "asc" | "desc" };

export const SORT_FIELDS: readonly string[] = [
  "bpm",
  "added",
  "artist",
  "title",
  "rating",
  "relevance",
];

/** Ascending reads naturally for names and numbers; for dates and for
 *  relevance the useful end is the other one. */
const DEFAULT_DIRECTION: Record<string, "asc" | "desc"> = {
  bpm: "asc",
  added: "desc",
  artist: "asc",
  title: "asc",
  rating: "desc",
  relevance: "desc",
};

export function parseSort(raw: string | undefined, hasQuery: boolean): SortSpec | SeratoError {
  if (raw === undefined) {
    // Decision 3 (2026-09-07): relevance is the default only when there is a
    // query for it to be relative to.
    return hasQuery
      ? { field: "relevance", dir: "desc" }
      : { field: "added", dir: DEFAULT_DIRECTION.added };
  }
  const [field, direction] = raw.split(":");
  if (!SORT_FIELDS.includes(field)) {
    return err("invalid_argument", `unknown sort field: ${field}`, {
      reason: "unknown_sort",
      field,
      allowed: SORT_FIELDS,
    });
  }
  if (direction !== undefined && direction !== "asc" && direction !== "desc") {
    return err("invalid_argument", `sort direction must be asc or desc, got: ${direction}`, {
      reason: "bad_sort",
      value: raw,
    });
  }
  if (field === "relevance" && !hasQuery) {
    return err("invalid_argument", "sort=relevance needs a q to be relevant to", {
      reason: "relevance_without_q",
    });
  }
  return { field, dir: direction ?? DEFAULT_DIRECTION[field] };
}

/** Escapes LIKE metacharacters; same rule as in filters.ts. */
function likeLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** Serato's normalised copy when the schema has it, the lowercased raw
 *  column otherwise. Parity with serato_str_norm is unreachable (spec
 *  2.9.1), so either is an approximation and the cheaper one wins. */
function textExpr(column: string, assetColumns: Set<string>): string | null {
  const hasNorm = assetColumns.has(`${column}_norm`);
  const hasRaw = assetColumns.has(column);
  // COALESCE, not just the normalised copy: the column exists in the schema
  // but is filled by a trigger that calls serato_str_norm, so a row written
  // by anything other than Serato has NULL there -- and ordering by NULL
  // would silently collapse the whole listing into the NULL block.
  if (hasNorm && hasRaw) return `COALESCE(a.${column}_norm, lower(a.${column}))`;
  if (hasNorm) return `a.${column}_norm`;
  if (hasRaw) return `lower(a.${column})`;
  return null;
}

export function sortExpressions(
  spec: SortSpec,
  assetColumns: Set<string>,
  q: string | undefined,
): { nullExpr: string; valExpr: string; params: unknown[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const unavailable = (field: string) => {
    warnings.push({
      code: "sort_unavailable",
      message: `this Serato schema has no column to sort by ${field}; ordered by id instead`,
      details: { field },
    });
    // a.id is never NULL, so the null flag is a constant here.
    return { nullExpr: "0", valExpr: "a.id", params: [] as unknown[], warnings };
  };

  if (spec.field === "relevance") {
    const needle = (q ?? "").trim().toLowerCase();
    const name = textExpr("name", assetColumns);
    if (name === null) return unavailable("relevance");
    const artist = textExpr("artist", assetColumns);
    const album = textExpr("album", assetColumns);
    const elsewhere = [artist, album].filter((e): e is string => e !== null);
    const params: unknown[] = [needle, `${likeLiteral(needle)}%`, `%${likeLiteral(needle)}%`];
    // Tokens govern what MATCHES (filters.ts); the whole string governs how
    // the matches RANK. Ranking on tokens would make "rain dance" score a
    // track called "Rain" above one called "Rain Dance".
    let sql = `CASE WHEN ${name} = ? THEN 4
                    WHEN ${name} LIKE ? ESCAPE '\\' THEN 3
                    WHEN ${name} LIKE ? ESCAPE '\\' THEN 2`;
    if (elsewhere.length > 0) {
      sql += ` WHEN ${elsewhere.map((e) => `${e} LIKE ? ESCAPE '\\'`).join(" OR ")} THEN 1`;
      for (const _ of elsewhere) params.push(`%${likeLiteral(needle)}%`);
    }
    sql += " ELSE 0 END";
    return { nullExpr: "0", valExpr: sql, params, warnings };
  }

  const textFields: Record<string, string> = { artist: "artist", title: "name" };
  if (Object.hasOwn(textFields, spec.field)) {
    const expr = textExpr(textFields[spec.field], assetColumns);
    if (expr === null) return unavailable(spec.field);
    return { nullExpr: `(${expr} IS NULL)`, valExpr: expr, params: [], warnings };
  }

  const plain: Record<string, string> = { bpm: "bpm", added: "time_added", rating: "rating" };
  const column = plain[spec.field];
  if (!assetColumns.has(column)) return unavailable(spec.field);
  return { nullExpr: `(a.${column} IS NULL)`, valExpr: `a.${column}`, params: [], warnings };
}

/**
 * "Everything strictly after this key" in the query's own ordering, which is
 * always (null flag ASC, value <dir>, id ASC).
 *
 * `_val IS ?` rather than `_val = ?`: IS is SQLite's NULL-safe equality, and
 * the whole point of the last clause is to break ties inside the NULL block,
 * where `=` yields NULL and the row is dropped.
 */
export function keysetPredicate(
  dir: "asc" | "desc",
  key: CursorKey,
): { sql: string; params: unknown[] } {
  const [nullFlag, value, id] = key;
  const compare = dir === "asc" ? ">" : "<";
  return {
    sql: `(_null > ? OR (_null = ? AND _val ${compare} ?) OR (_null = ? AND _val IS ? AND _id > ?))`,
    params: [nullFlag, nullFlag, value, nullFlag, value, id],
  };
}
