import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { DEFAULT_FIELDS, mapRow, resolveFields } from "../read/fields.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";

export const MAX_IDS = 200;

export const getTracksInput = z.object({
  ids: z.array(z.number().int()).min(1).max(MAX_IDS),
  fields: z.array(z.string()).min(1).optional(),
});

export const getTracksOutput = z.object({
  found: z.array(z.record(z.string(), z.unknown())),
  missing: z.array(z.number()),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const getTracksDescription =
  "Fetch tracks by the ids search_tracks returned. Unknown ids come back in `missing` rather " +
  "than being dropped silently, and `found` is in the order the ids were given. " +
  `Default fields: ${DEFAULT_FIELDS.join(", ")}. Paths are redacted to ~.`;

export async function getTracks(
  raw: unknown,
  ctx: ReadCtx,
): Promise<
  | ({ found: Record<string, unknown>[]; missing: number[] } & {
      generation?: string;
      warnings?: Warning[];
    })
  | SeratoError
> {
  const args = parseToolArgs(getTracksInput, raw);
  if (isSeratoError(args)) return args;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);
    const projection = resolveFields(args.fields, handle.schema.assetColumns);
    if (isSeratoError(projection)) return projection;
    warnings.push(...projection.warnings);

    const placeholders = args.ids.map(() => "?").join(", ");
    const rows = handle.db
      .prepare(
        `SELECT ${projection.select}
           FROM asset a LEFT JOIN mcp_key k ON k.asset_id = a.id
          WHERE a.id IN (${placeholders})`,
      )
      .all(...(args.ids as never[])) as Record<string, unknown>[];

    const byId = new Map<number, Record<string, unknown>>();
    for (const row of rows) byId.set(Number(row.id), row);

    const found: Record<string, unknown>[] = [];
    const missing: number[] = [];
    // The caller's order, not the database's: it lines these up against its
    // own list, and a reordered answer makes that silently wrong.
    for (const id of args.ids) {
      const row = byId.get(id);
      if (row === undefined) missing.push(id);
      else found.push(mapRow(row, projection.fields, handle.volumeRoots));
    }

    return ok({ found, missing }, handle.snapshot.generation, warnings);
  });
}
