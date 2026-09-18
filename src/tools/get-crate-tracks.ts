import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { type Crate, resolveCrate } from "../read/crates.js";
import {
  checkCursor,
  DEFAULT_TRACK_LIMIT,
  fingerprint,
  MAX_CURSOR_LENGTH,
  MAX_TRACK_LIMIT,
  nextCursorFrom,
} from "../read/cursor.js";
import { ALL_FIELDS, DEFAULT_FIELDS, mapRow, resolveFields } from "../read/fields.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";
import { keysetPredicate } from "../read/sort.js";

export const getCrateTracksInput = z
  .object({
    crate_id: z.number().int().optional(),
    crate_name: z.string().optional(),
    // Same bounds as search_tracks, and for the same reason: a caller must
    // not be able to reach the unbounded-cursor or unbounded-fields failure
    // through this tool just because search_tracks closed it off in its own
    // schema.
    fields: z.array(z.string()).min(1).max(ALL_FIELDS.length).optional(),
    limit: z.number().int().min(1).max(MAX_TRACK_LIMIT).optional(),
    cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  })
  .refine((v) => !(v.crate_id !== undefined && v.crate_name !== undefined), {
    error: "crate_id and crate_name cannot both be given",
    params: { reason: "crate_ref_conflict" },
  });

export const getCrateTracksOutput = z.object({
  crate: z.object({
    id: z.number(),
    name: z.string(),
    space: z.string(),
    path: z.string(),
    parent_id: z.number().nullable(),
    type: z.number(),
    track_count: z.number(),
  }),
  tracks: z.array(z.record(z.string(), z.unknown())),
  next_cursor: z.string().optional(),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const getCrateTracksDescription =
  "List the tracks of one crate, in the crate's own order -- the order the DJ arranged, not " +
  "the order they were added to the library. Only crates in the Serato Library space can be " +
  "given. Give the crate by id or by exact name; an unknown name comes back with the list of " +
  `names that exist. Default fields: ${DEFAULT_FIELDS.join(", ")}. Paths are redacted to ~.`;

export async function getCrateTracks(
  raw: unknown,
  ctx: ReadCtx,
): Promise<
  | ({ crate: Crate; tracks: Record<string, unknown>[]; next_cursor?: string } & {
      generation?: string;
      warnings?: Warning[];
    })
  | SeratoError
> {
  const args = parseToolArgs(getCrateTracksInput, raw);
  if (isSeratoError(args)) return args;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);

    const crate = resolveCrate(handle.db, { id: args.crate_id, name: args.crate_name });
    if (isSeratoError(crate)) return crate;

    const projection = resolveFields(args.fields, handle.schema.assetColumns);
    if (isSeratoError(projection)) return projection;
    warnings.push(...projection.warnings);

    const fp = fingerprint({ tool: "get_crate_tracks", crate: crate.id, fields: args.fields });
    let keyset = { sql: "1", params: [] as unknown[] };
    if (args.cursor !== undefined) {
      const checked = checkCursor(args.cursor, fp, handle.snapshot.generation);
      if (isSeratoError(checked)) return checked;
      warnings.push(...checked.warnings);
      keyset = keysetPredicate("asc", checked.key);
    }

    const limit = args.limit ?? DEFAULT_TRACK_LIMIT;
    // GROUP BY a.id with min(list_order): location_container is 1:N, so a
    // track reachable through two locations would otherwise be listed twice
    // (observed on container 15 of the real library).
    const sql = `SELECT * FROM (
      SELECT ${projection.select},
             (min(ca.list_order) IS NULL) AS _null, min(ca.list_order) AS _val, a.id AS _id
        FROM asset a
        LEFT JOIN mcp_key k ON k.asset_id = a.id
        JOIN container_asset ca ON ca.asset_id = a.id
        JOIN location_container lc ON lc.id = ca.location_container_id
       WHERE lc.container_id = ?
       GROUP BY a.id
    ) WHERE ${keyset.sql}
      ORDER BY _null ASC, _val ASC, _id ASC
      LIMIT ?`;

    const rows = handle.db
      .prepare(sql)
      .all(...([crate.id, ...keyset.params, limit + 1] as never[])) as Record<string, unknown>[];

    const page = rows.slice(0, limit);
    const tracks = page.map((row) => mapRow(row, projection.fields, handle.volumeRoots));

    const next = nextCursorFrom(
      rows.length > limit,
      page[page.length - 1],
      fp,
      handle.snapshot.generation,
    );

    const payload: { crate: Crate; tracks: Record<string, unknown>[]; next_cursor?: string } = {
      crate,
      tracks,
    };
    if (next !== undefined) payload.next_cursor = next;
    return ok(payload, handle.snapshot.generation, warnings);
  });
}
