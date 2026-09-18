import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { type Crate, listCrates } from "../read/crates.js";
import {
  checkCursor,
  DEFAULT_CRATE_LIMIT,
  encodeCursor,
  fingerprint,
  MAX_CRATE_LIMIT,
  MAX_CURSOR_LENGTH,
} from "../read/cursor.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";

export const listCratesInput = z.object({
  limit: z.number().int().min(1).max(MAX_CRATE_LIMIT).optional(),
  // Same bound as every other cursor-taking tool, and for the same reason:
  // one unbounded cursor anywhere is one unbounded cursor too many.
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

const crateSchema = z.object({
  id: z.number(),
  name: z.string(),
  space: z.string(),
  path: z.string(),
  parent_id: z.number().nullable(),
  type: z.number(),
  track_count: z.number(),
});

export const listCratesOutput = z.object({
  crates: z.array(crateSchema),
  next_cursor: z.string().optional(),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const listCratesDescription =
  "List the crates in the Serato Library space, with their display path and how many distinct " +
  "tracks each holds. Only crates in that space are listed: smart crates, space roots and " +
  "Serato's other internal spaces (such as the Prepare panel) are excluded.";

export async function listCratesTool(
  raw: unknown,
  ctx: ReadCtx,
): Promise<
  | ({ crates: Crate[]; next_cursor?: string } & { generation?: string; warnings?: Warning[] })
  | SeratoError
> {
  const args = parseToolArgs(listCratesInput, raw);
  if (isSeratoError(args)) return args;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);
    const limit = args.limit ?? DEFAULT_CRATE_LIMIT;
    // The listing takes no filters, so its identity is only its own name --
    // but it still goes through the same cursor machinery as the others, so
    // there is one way for a cursor to be wrong rather than two.
    const fp = fingerprint({ tool: "list_crates" });

    let afterId: number | undefined;
    if (args.cursor !== undefined) {
      const checked = checkCursor(args.cursor, fp, handle.snapshot.generation);
      if (isSeratoError(checked)) return checked;
      warnings.push(...checked.warnings);
      afterId = checked.key[2];
    }

    // limit + 1: the extra row is how "there is a next page" is known without
    // a second COUNT query over the whole library.
    const rows = listCrates(handle.db, { limit: limit + 1, afterId });
    const page = rows.slice(0, limit);
    const next =
      rows.length > limit && page.length > 0
        ? encodeCursor({
            fp,
            gen: handle.snapshot.generation,
            key: [0, page[page.length - 1].id, page[page.length - 1].id],
          })
        : undefined;

    const payload: { crates: Crate[]; next_cursor?: string } = { crates: page };
    if (next !== undefined) payload.next_cursor = next;
    return ok(payload, handle.snapshot.generation, warnings);
  });
}
