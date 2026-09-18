import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { resolveLibrary } from "../discovery/index.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { loadStage } from "../stage/store.js";
import type { WriteCtx } from "./stage-crate.js";

export const previewChangesInput = z.object({
  format: z.enum(["summary", "detail"]).optional(),
});

const trackSchema = z.object({ id: z.number(), title: z.string(), artist: z.string() });

export const previewChangesOutput = z.object({
  pending: z.array(
    z.object({
      staged_id: z.string(),
      name: z.string(),
      track_count: z.number(),
      tracks: z.array(trackSchema).optional(),
    }),
  ),
  summary: z.string(),
  staged_at: z.string().nullable(),
  generation: z.string().optional(),
  warnings: z.array(warningSchema).optional(),
});

export const previewChangesDescription =
  'Show what apply_changes would write: every staged crate, and with format "detail" every ' +
  "track in it by title and artist. Reads only the stage; the library is not touched.";

type Pending = {
  staged_id: string;
  name: string;
  track_count: number;
  tracks?: { id: number; title: string; artist: string }[];
};

export async function previewChanges(
  raw: unknown,
  ctx: WriteCtx,
): Promise<
  | ({ pending: Pending[]; summary: string; staged_at: string | null } & {
      generation?: string;
      warnings?: Warning[];
    })
  | SeratoError
> {
  const args = parseToolArgs(previewChangesInput, raw);
  if (isSeratoError(args)) return args;
  const lib = resolveLibrary({ library: ctx.library, roots: ctx.roots });
  if (isSeratoError(lib)) return lib;
  const stage = loadStage(ctx.stateDir, lib.uuid);
  if (isSeratoError(stage)) return stage;

  const crates = stage?.crates ?? [];
  const detail = args.format === "detail";
  const pending: Pending[] = crates.map((c) => ({
    staged_id: c.staged_id,
    name: c.name,
    track_count: c.tracks.length,
    ...(detail
      ? { tracks: c.tracks.map((t) => ({ id: t.track_id, title: t.title, artist: t.artist })) }
      : {}),
  }));
  const trackTotal = crates.reduce((n, c) => n + c.tracks.length, 0);
  const staged = crates.map((c) => c.staged_at).sort();
  // A stage is not bound to a snapshot, and the envelope's `generation`
  // field is what every other tool uses for the live snapshot -- putting the
  // stage's own generation there would be misleading, so it is left absent.
  return ok({
    pending,
    summary: `${crates.length} crate${crates.length === 1 ? "" : "s"}, ${trackTotal} track${trackTotal === 1 ? "" : "s"}`,
    staged_at: staged[0] ?? null,
  });
}
