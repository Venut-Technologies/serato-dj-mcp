import type { Warning } from "../envelope.js";
import { err, type SeratoError } from "../errors.js";

export type FilterArgs = {
  q?: string;
  bpm?: { min?: number; max?: number; around?: number; tolerance_pct?: number };
  key?: { camelot?: string[]; compatible_with?: string };
  genre?: string;
  rating?: { min?: number; max?: number };
  added?: { before?: string; after?: string };
  flags?: { analyzed?: boolean; missing?: boolean; streaming?: boolean };
};

/** Free-text search covers these fields. Each is matched twice: against
 *  Serato's own normalised copy and against the raw column lowercased --
 *  parity with serato_str_norm is unreachable, so both are tried. */
export const SEARCH_COLUMNS: readonly string[] = ["name", "artist", "album", "genre", "comments"];

/** The pitch range of a typical CD deck, and the window a DJ means by "around
 *  124". Overridable per call. */
export const DEFAULT_BPM_TOLERANCE_PCT = 6;

const CAMELOT = /^(1[0-2]|[1-9])([AB])$/;

/**
 * The four cells of the Camelot wheel that mix: the same cell, one step
 * either way around the ring, and the parallel key at the same number.
 * Wraparound is real -- 12A and 1A are neighbours.
 */
export function compatibleCamelot(cell: string): string[] | null {
  const m = CAMELOT.exec(cell.trim().toUpperCase());
  if (m === null) return null;
  const n = Number(m[1]);
  const letter = m[2];
  const down = n === 1 ? 12 : n - 1;
  const up = n === 12 ? 1 : n + 1;
  return [
    `${n}${letter}`,
    `${down}${letter}`,
    `${up}${letter}`,
    `${n}${letter === "A" ? "B" : "A"}`,
  ];
}

/** Escapes the LIKE metacharacters so a model sending "%" searches for a
 *  percent sign rather than matching the whole library. Exported: sort.ts
 *  needs the identical rule for its relevance ranking, and two copies of an
 *  escaping helper is the kind of duplication where divergence goes unnoticed
 *  until it matters (found in review, 2026-09-13). */
export function likeLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function unixSeconds(value: string): number | null {
  // Date-only strings parse as UTC midnight, which is what a filter on a day
  // boundary should mean.
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * Every filter this schema cannot express is reported, never dropped in
 * silence.
 *
 * A whole-branch review found this module was the only one of three siblings
 * without that discipline: resolveFields warns with `field_unavailable` and
 * sortExpressions with `sort_unavailable`, while a dropped predicate here
 * turned `bpm: {min: 122, max: 126}` on a schema without a bpm column into
 * THE WHOLE LIBRARY, presented as a filtered answer. The rule is that
 * nothing is dropped silently, and a filtered read is exactly where a silent
 * drop misleads most.
 *
 * Argument validation, in contrast, no longer depends on the schema at all:
 * a self-contradictory argument is refused whether or not the column it
 * names exists, because the mistake is in the call either way.
 */
export function buildFilters(
  args: FilterArgs,
  assetColumns: Set<string>,
  crateId?: number,
): { where: string[]; params: unknown[]; warnings: Warning[] } | SeratoError {
  const where: string[] = [];
  const params: unknown[] = [];
  const warnings: Warning[] = [];
  const has = (c: string) => assetColumns.has(c);
  const unavailable = (filter: string, columns: string[]) => {
    warnings.push({
      code: "filter_unavailable",
      message: `this Serato schema cannot filter by ${filter}; that condition was not applied`,
      details: { filter, columns },
    });
  };

  if (args.q !== undefined && args.q.trim() !== "") {
    // Tokens through AND (decided 2026-09-07): each token must appear in at
    // least one searched field; word order does not matter.
    for (const token of args.q.trim().split(/\s+/)) {
      const pattern = `%${likeLiteral(token.toLowerCase())}%`;
      const clauses: string[] = [];
      for (const column of SEARCH_COLUMNS) {
        if (has(column)) {
          clauses.push(`lower(a.${column}) LIKE ? ESCAPE '\\'`);
          params.push(pattern);
        }
        const norm = `${column}_norm`;
        if (has(norm)) {
          clauses.push(`a.${norm} LIKE ? ESCAPE '\\'`);
          params.push(pattern);
        }
      }
      // No searchable column at all: the filter cannot be satisfied, and
      // silently returning everything would be worse than returning nothing.
      // The empty page still needs explaining, hence the warning.
      if (clauses.length === 0) unavailable("q", [...SEARCH_COLUMNS]);
      where.push(clauses.length > 0 ? `(${clauses.join(" OR ")})` : "0");
    }
  }

  if (args.bpm !== undefined) {
    const { min, max, around } = args.bpm;
    // Validated before the column check: an argument that contradicts itself
    // is a bad call regardless of what this schema happens to carry.
    if (around !== undefined && (min !== undefined || max !== undefined)) {
      return err("invalid_argument", "bpm.around cannot be combined with bpm.min or bpm.max", {
        reason: "bpm_around_conflict",
      });
    }
    if (!has("bpm")) {
      unavailable("bpm", ["bpm"]);
    } else if (around !== undefined) {
      const tolerance = args.bpm.tolerance_pct ?? DEFAULT_BPM_TOLERANCE_PCT;
      where.push("a.bpm IS NOT NULL AND a.bpm >= ? AND a.bpm <= ?");
      params.push(around * (1 - tolerance / 100), around * (1 + tolerance / 100));
    } else {
      if (min !== undefined) {
        where.push("a.bpm IS NOT NULL AND a.bpm >= ?");
        params.push(min);
      }
      if (max !== undefined) {
        where.push("a.bpm IS NOT NULL AND a.bpm <= ?");
        params.push(max);
      }
    }
  }

  if (args.key !== undefined) {
    const { camelot, compatible_with: compatibleWith } = args.key;
    if (camelot !== undefined && compatibleWith !== undefined) {
      return err("invalid_argument", "key.camelot cannot be combined with key.compatible_with", {
        reason: "key_filter_conflict",
      });
    }
    let cells: string[] | null = null;
    if (compatibleWith !== undefined) {
      cells = compatibleCamelot(compatibleWith);
      if (cells === null) {
        return err("invalid_argument", `not a Camelot key: ${compatibleWith}`, {
          reason: "bad_camelot",
          value: compatibleWith,
        });
      }
    } else if (camelot !== undefined) {
      cells = [];
      for (const cell of camelot) {
        const m = CAMELOT.exec(cell.trim().toUpperCase());
        if (m === null) {
          return err("invalid_argument", `not a Camelot key: ${cell}`, {
            reason: "bad_camelot",
            value: cell,
          });
        }
        cells.push(`${Number(m[1])}${m[2]}`);
      }
    }
    if (cells !== null) {
      // Reads the derived table, which is why tracks whose key only exists
      // as Open Key text are in scope at all: 75 of 118 on the real library.
      where.push(`k.camelot IN (${cells.map(() => "?").join(", ")})`);
      params.push(...cells);
    }
  }

  if (args.genre !== undefined) {
    if (has("genre")) {
      where.push("lower(a.genre) LIKE ? ESCAPE '\\'");
      params.push(`%${likeLiteral(args.genre.toLowerCase())}%`);
    } else {
      unavailable("genre", ["genre"]);
    }
  }

  if (args.rating !== undefined && !has("rating")) unavailable("rating", ["rating"]);
  if (args.rating !== undefined && has("rating")) {
    if (args.rating.min !== undefined) {
      where.push("a.rating IS NOT NULL AND a.rating >= ?");
      params.push(args.rating.min);
    }
    if (args.rating.max !== undefined) {
      where.push("a.rating IS NOT NULL AND a.rating <= ?");
      params.push(args.rating.max);
    }
  }

  if (args.added !== undefined) {
    const applicable = has("time_added");
    if (!applicable) unavailable("added", ["time_added"]);
    for (const [key, op] of [
      ["after", ">="],
      ["before", "<="],
    ] as const) {
      const value = args.added[key];
      if (value === undefined) continue;
      // Parsed before the column check, for the same reason as bpm above: a
      // date this server cannot read is a bad argument either way.
      const seconds = unixSeconds(value);
      if (seconds === null) {
        return err("invalid_argument", `added.${key} is not a date: ${value}`, {
          reason: "bad_date",
          value,
        });
      }
      if (!applicable) continue;
      where.push(`a.time_added ${op} ?`);
      params.push(seconds);
    }
  }

  if (crateId !== undefined) {
    // location_container is 1:N (observed on container 15 of the real
    // library), so this is a membership test, not a join that could
    // duplicate rows.
    where.push(
      `a.id IN (SELECT ca.asset_id FROM container_asset ca
                  JOIN location_container lc ON lc.id = ca.location_container_id
                 WHERE lc.container_id = ?)`,
    );
    params.push(crateId);
  }

  if (args.flags !== undefined) {
    const { analyzed, missing, streaming } = args.flags;
    if (analyzed !== undefined && !has("analysis_flags")) {
      unavailable("flags.analyzed", ["analysis_flags"]);
    }
    if (analyzed !== undefined && has("analysis_flags")) {
      // Bit 2 is "Serato ran its own analysis" -- not "has a BPM", which can
      // come from tags (measured 2026-09-06 on 118 tracks).
      where.push(analyzed ? "(a.analysis_flags & 4) <> 0" : "(a.analysis_flags & 4) = 0");
    }
    if (missing !== undefined && !has("is_missing")) unavailable("flags.missing", ["is_missing"]);
    if (missing !== undefined && has("is_missing")) {
      where.push(missing ? "a.is_missing <> 0" : "a.is_missing = 0");
    }
    if (streaming !== undefined && !(has("third_party_type") && has("portable_id"))) {
      unavailable("flags.streaming", ["third_party_type", "portable_id"]);
    }
    if (streaming !== undefined && has("third_party_type") && has("portable_id")) {
      const test = "(a.third_party_type <> 0 OR a.portable_id LIKE 'streaming://%')";
      where.push(streaming ? test : `NOT ${test}`);
    }
  }

  return { where, params, warnings };
}
