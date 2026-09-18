import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { resolveCrate } from "../read/crates.js";
import {
  checkCursor,
  DEFAULT_TRACK_LIMIT,
  fingerprint,
  MAX_CURSOR_LENGTH,
  MAX_TRACK_LIMIT,
  nextCursorFrom,
} from "../read/cursor.js";
import { ALL_FIELDS, DEFAULT_FIELDS, mapRow, resolveFields } from "../read/fields.js";
import { buildFilters } from "../read/filters.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";
import { keysetPredicate, parseSort, SORT_FIELDS, sortExpressions } from "../read/sort.js";

/**
 * Bounds on model-supplied strings and arrays that feed straight into SQL
 * text or parameter lists. Uncapped, `q`
 * builds one ten-clause OR group per whitespace token, ANDed together:
 * measured at 988 tokens that all match up to the last, the query itself ran
 * for tens of seconds with no way to interrupt it (node:sqlite is
 * synchronous); at 989 tokens SQLite's prepare() throws "Expression tree is
 * too large (maximum depth 1000)", which readSession's outer catch turns
 * into `snapshot_failed` -- telling the model the snapshot copy is broken
 * rather than that its argument was too big. Twelve tokens covers any real
 * search and stays far enough below 988 that the second failure mode is
 * unreachable.
 */
const MAX_Q_LENGTH = 512;
const MAX_Q_TOKENS = 12;
/** 24 cells exist on the Camelot wheel; more is never meaningful, and an
 *  unbounded IN list can exceed SQLite's bound-variable limit and surface as
 *  `snapshot_failed` the same way an oversized `q` does. */
const MAX_CAMELOT_CELLS = 24;
const MAX_GENRE_LENGTH = 256;
const MAX_CRATE_NAME_LENGTH = 256;

/** Counts q's tokens the same way filters.ts splits them, so the schema
 *  refuses exactly the inputs filters.ts would otherwise have to chew on. */
function qTokenCount(q: string): number {
  const trimmed = q.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

export const searchTracksInput = z
  .object({
    q: z.string().max(MAX_Q_LENGTH).optional(),
    bpm: z
      .object({
        min: z.number().optional(),
        max: z.number().optional(),
        around: z.number().optional(),
        tolerance_pct: z.number().min(0).max(50).optional(),
      })
      .optional(),
    key: z
      .object({
        camelot: z.array(z.string()).min(1).max(MAX_CAMELOT_CELLS).optional(),
        compatible_with: z.string().optional(),
      })
      .optional(),
    genre: z.string().max(MAX_GENRE_LENGTH).optional(),
    // The DDL carries CHECK (rating IS NULL OR rating BETWEEN 0 AND 1): rating
    // is a 0..1 REAL, not 0..5 stars. Bounding min/max here turns the obvious
    // wrong guess (e.g. min: 4) into an invalid_argument the model can act
    // on, instead of a silent empty page.
    rating: z
      .object({
        min: z.number().min(0).max(1).optional(),
        max: z.number().min(0).max(1).optional(),
      })
      .optional(),
    added: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
    crate: z
      .object({
        id: z.number().int().optional(),
        name: z.string().max(MAX_CRATE_NAME_LENGTH).optional(),
      })
      .optional(),
    flags: z
      .object({
        analyzed: z.boolean().optional(),
        missing: z.boolean().optional(),
        streaming: z.boolean().optional(),
      })
      .optional(),
    sort: z.string().optional(),
    fields: z.array(z.string()).min(1).max(ALL_FIELDS.length).optional(),
    limit: z.number().int().min(1).max(MAX_TRACK_LIMIT).optional(),
    cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  })
  // The only cross-field check that has to live here: the other two the spec
  // names are decided where the knowledge is -- bpm.around against min/max in
  // filters.ts, and the cursor against its query in cursor.ts.
  .refine((v) => !(v.crate?.id !== undefined && v.crate?.name !== undefined), {
    error: "crate.id and crate.name cannot both be given",
    params: { reason: "crate_ref_conflict" },
  })
  // A per-field .max() on q would report "schema_violation" -- true but
  // useless, since the model cannot tell a too-long q from a too-long
  // anything else. This gets its own reason so the model knows exactly what
  // to shorten (finding 1).
  .refine((v) => v.q === undefined || qTokenCount(v.q) <= MAX_Q_TOKENS, {
    error: `q has too many tokens (max ${MAX_Q_TOKENS})`,
    params: { reason: "too_many_tokens" },
  });

export const searchTracksOutput = z.object({
  tracks: z.array(z.record(z.string(), z.unknown())),
  next_cursor: z.string().optional(),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const searchTracksDescription =
  "Search the Serato library. Free text `q` matches every whitespace-separated token against " +
  "title, artist, album, genre and comments. Tonality is Camelot (`8A`); tracks whose key " +
  "Serato itself could not parse are included, and `key_source` says where each key came from. " +
  "`bpm.around` cannot be combined with `bpm.min`/`bpm.max`. `key.compatible_with` expands to " +
  "the four mixable cells of the wheel. `rating` is a 0 to 1 scale, not 0 to 5 stars. Sort is one of " +
  `${SORT_FIELDS.join(", ")} with an optional :asc/:desc; relevance needs a q. ` +
  `Default fields: ${DEFAULT_FIELDS.join(", ")}. Paths are redacted to ~.`;

export async function searchTracks(
  raw: unknown,
  ctx: ReadCtx,
): Promise<
  | ({ tracks: Record<string, unknown>[]; next_cursor?: string } & {
      generation?: string;
      warnings?: Warning[];
    })
  | SeratoError
> {
  const args = parseToolArgs(searchTracksInput, raw);
  if (isSeratoError(args)) return args;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);

    const projection = resolveFields(args.fields, handle.schema.assetColumns);
    if (isSeratoError(projection)) return projection;
    warnings.push(...projection.warnings);

    let crateId: number | undefined;
    if (args.crate !== undefined) {
      const crate = resolveCrate(handle.db, args.crate);
      if (isSeratoError(crate)) return crate;
      crateId = crate.id;
    }

    const filters = buildFilters(args, handle.schema.assetColumns, crateId);
    if (isSeratoError(filters)) return filters;
    warnings.push(...filters.warnings);

    const hasQuery = args.q !== undefined && args.q.trim() !== "";
    const sort = parseSort(args.sort, hasQuery);
    if (isSeratoError(sort)) return sort;
    const order = sortExpressions(sort, handle.schema.assetColumns, args.q);
    warnings.push(...order.warnings);

    // Everything except cursor and limit: those are exactly what may change
    // between pages of one query.
    const { cursor, limit: _limit, ...identity } = args;
    const fp = fingerprint(identity);

    let keyset = { sql: "1", params: [] as unknown[] };
    if (cursor !== undefined) {
      const checked = checkCursor(cursor, fp, handle.snapshot.generation);
      if (isSeratoError(checked)) return checked;
      warnings.push(...checked.warnings);
      keyset = keysetPredicate(sort.dir, checked.key);
    }

    const limit = args.limit ?? DEFAULT_TRACK_LIMIT;
    const where = filters.where.length > 0 ? `WHERE ${filters.where.join(" AND ")}` : "";
    // Two layers: the inner one computes the sort key, the outer one applies
    // the keyset to it. A single layer cannot -- the keyset compares against
    // an expression the WHERE clause has not produced yet.
    const sql = `SELECT * FROM (
      SELECT ${projection.select}, ${order.nullExpr} AS _null, ${order.valExpr} AS _val, a.id AS _id
        FROM asset a LEFT JOIN mcp_key k ON k.asset_id = a.id
        ${where}
    ) WHERE ${keyset.sql}
      ORDER BY _null ASC, _val ${sort.dir === "asc" ? "ASC" : "DESC"}, _id ASC
      LIMIT ?`;

    // Order matters and follows the SQL text: select list, then filters,
    // then the keyset, then the row cap.
    const params = [...order.params, ...filters.params, ...keyset.params, limit + 1];
    const rows = handle.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];

    // limit + 1: the extra row answers "is there a next page" without a
    // second COUNT over the whole library.
    const page = rows.slice(0, limit);
    const tracks = page.map((row) => mapRow(row, projection.fields, handle.volumeRoots));

    const next = nextCursorFrom(
      rows.length > limit,
      page[page.length - 1],
      fp,
      handle.snapshot.generation,
    );

    const payload: { tracks: Record<string, unknown>[]; next_cursor?: string } = { tracks };
    if (next !== undefined) payload.next_cursor = next;
    return ok(payload, handle.snapshot.generation, warnings);
  });
}
