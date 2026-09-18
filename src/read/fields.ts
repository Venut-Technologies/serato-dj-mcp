import type { Warning } from "../envelope.js";
import { err, type SeratoError } from "../errors.js";
import { isStreamingPortableId, portableIdToAbsolute, redactPath } from "../paths.js";
import { pickColumns } from "../schema/index.js";

type FieldSpec = {
  /** asset columns this field can come from, best first. Empty when the
   *  value comes from the derived mcp_key table instead. */
  candidates: readonly string[];
  /** SQL expression; `column` is the first candidate the schema actually
   *  has, or null for a derived field. */
  sql: (column: string | null) => string;
  /** Columns map() needs but the caller never sees. Selected under an
   *  underscore alias and stripped in mapRow. */
  extra?: readonly string[];
  map?: (value: unknown, row: Record<string, unknown>, roots: Map<number, string>) => unknown;
};

/**
 * The closed list of fields. Closed on purpose: a model asking for a column
 * that happens to exist in Serato's schema would get a value nobody has
 * verified the meaning of.
 */
export const FIELD_SPECS: Record<string, FieldSpec> = {
  id: { candidates: ["id"], sql: (c) => `a.${c}` },
  title: { candidates: ["name"], sql: (c) => `a.${c}` },
  artist: { candidates: ["artist"], sql: (c) => `a.${c}` },
  album: { candidates: ["album"], sql: (c) => `a.${c}` },
  genre: { candidates: ["genre"], sql: (c) => `a.${c}` },
  comments: { candidates: ["comments"], sql: (c) => `a.${c}` },
  bpm: { candidates: ["bpm"], sql: (c) => `a.${c}` },
  // Uninterpreted on purpose: on the reference library rating was NULL or 0
  // on all 118 tracks, so the top of the scale is unconfirmed.
  rating: { candidates: ["rating"], sql: (c) => `a.${c}` },
  // Milliseconds. length_ms leads because length_sec was NULL on all 19 demo
  // tracks while length_ms was populated (measured 2026-09-03).
  length: {
    candidates: ["length_ms", "length_sec"],
    sql: (c) => (c === "length_ms" ? "a.length_ms" : "a.length_sec * 1000"),
  },
  added: {
    candidates: ["time_added"],
    sql: (c) => `a.${c}`,
    map: (v) => (typeof v === "number" ? new Date(v * 1000).toISOString() : null),
  },
  play_count: { candidates: ["dj_play_count"], sql: (c) => `a.${c}` },
  missing: { candidates: ["is_missing"], sql: (c) => `a.${c} <> 0`, map: toBoolean },
  streaming: { candidates: ["third_party_type"], sql: (c) => `a.${c} <> 0`, map: toBoolean },
  // analysis_flags & 4 means "Serato ran its own analysis", which is NOT the
  // same as "has a BPM" -- a BPM can come from the file's tags. Measured
  // 2026-09-06 on 118 tracks: 94 of 106 agree, and the twelve that differ
  // are six sound effects and six tracks whose BPM came from tags.
  analyzed: { candidates: ["analysis_flags"], sql: (c) => `(a.${c} & 4) <> 0`, map: toBoolean },
  path: {
    candidates: ["portable_id"],
    sql: (c) => `a.${c}`,
    extra: ["location_id"],
    map: (value, row, roots) => {
      if (typeof value !== "string") return null;
      if (isStreamingPortableId(value)) return value;
      const root = roots.get(row._location_id as number);
      if (root === undefined) return value;
      return redactPath(portableIdToAbsolute(root, value));
    },
  },
  key: { candidates: [], sql: () => "k.camelot" },
  key_source: { candidates: [], sql: () => "k.source" },
};

export const ALL_FIELDS: readonly string[] = Object.keys(FIELD_SPECS);

/** key_source exists so the model can tell Serato's own parse from ours:
 *  75 of 118 real tracks only have ours. */
export const DEFAULT_FIELDS: readonly string[] = [
  "id",
  "artist",
  "title",
  "bpm",
  "key",
  "key_source",
  "genre",
  "rating",
  "length",
];

function toBoolean(value: unknown): unknown {
  return typeof value === "number" ? value !== 0 : value;
}

export function resolveFields(
  requested: string[] | undefined,
  assetColumns: Set<string>,
): { fields: string[]; select: string; warnings: Warning[] } | SeratoError {
  const asked = requested ?? [...DEFAULT_FIELDS];
  for (const field of asked) {
    if (!Object.hasOwn(FIELD_SPECS, field)) {
      return err("invalid_argument", `unknown field: ${field}`, {
        reason: "unknown_field",
        field,
        allowed: ALL_FIELDS,
      });
    }
  }

  // id is the keyset tie-breaker and the handle get_tracks resolves by: a
  // page without it cannot be paginated or followed up on.
  const wanted = asked.includes("id") ? [...asked] : ["id", ...asked];

  const fields: string[] = [];
  const parts: string[] = [];
  const extras = new Set<string>();
  const warnings: Warning[] = [];

  for (const field of wanted) {
    const spec = FIELD_SPECS[field];
    let column: string | null = null;
    if (spec.candidates.length > 0) {
      const found = pickColumns(assetColumns, spec.candidates);
      if (found.length === 0) {
        warnings.push({
          code: "field_unavailable",
          message: `this Serato schema has no column for ${field}`,
          details: { field },
        });
        continue;
      }
      column = found[0];
    }
    fields.push(field);
    // Quoted: `key` is a SQLite keyword, and an unquoted alias by that
    // name is a coin flip across versions.
    parts.push(`${spec.sql(column)} AS "${field}"`);
    for (const extra of spec.extra ?? []) {
      if (assetColumns.has(extra)) extras.add(extra);
    }
  }

  for (const extra of extras) parts.push(`a.${extra} AS "_${extra}"`);

  return { fields, select: parts.join(", "), warnings };
}

/**
 * Turns one SQL row into the object the model sees: only the requested
 * fields, in the requested order, with the helper columns (`_location_id`
 * and the keyset columns `_null`, `_val`, `_id`) stripped.
 */
export function mapRow(
  row: Record<string, unknown>,
  fields: readonly string[],
  volumeRoots: Map<number, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const spec = FIELD_SPECS[field];
    const raw = row[field];
    out[field] = spec?.map === undefined ? raw : spec.map(raw, row, volumeRoots);
  }
  return out;
}
