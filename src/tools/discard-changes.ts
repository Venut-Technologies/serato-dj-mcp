import { z } from "zod";
import { acquireWriteLock } from "../apply/mutex.js";
import { parseToolArgs } from "../args.js";
import { resolveLibrary } from "../discovery/index.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { clearStage, loadStage, saveStage } from "../stage/store.js";
import type { WriteCtx } from "./stage-crate.js";

export const discardChangesInput = z.object({
  staged_id: z.string().min(1).max(64).optional(),
});

export const discardChangesOutput = z.object({
  discarded_ids: z.array(z.string()),
  warnings: z.array(warningSchema).optional(),
});

export const discardChangesDescription =
  "Remove a staged crate by staged_id, or everything staged when no id is given. The library " +
  "is not touched -- staged crates were never written to it.";

export async function discardChanges(
  raw: unknown,
  ctx: WriteCtx,
): Promise<({ discarded_ids: string[] } & { warnings?: Warning[] }) | SeratoError> {
  const args = parseToolArgs(discardChangesInput, raw);
  if (isSeratoError(args)) return args;
  const lib = resolveLibrary({ library: ctx.library, roots: ctx.roots });
  if (isSeratoError(lib)) return lib;

  // Load-modify-save with no lock lets a concurrent stage_crate or
  // discard_changes silently drop the other's write.
  const lock = acquireWriteLock(ctx.stateDir, lib.uuid);
  if (isSeratoError(lock)) return lock;
  try {
    const stage = loadStage(ctx.stateDir, lib.uuid);
    if (isSeratoError(stage)) return stage;
    const crates = stage?.crates ?? [];

    if (args.staged_id === undefined) {
      clearStage(ctx.stateDir, lib.uuid);
      return ok({ discarded_ids: crates.map((c) => c.staged_id) });
    }
    if (stage === null || !crates.some((c) => c.staged_id === args.staged_id)) {
      return err("unknown_ids", `nothing is staged with id ${args.staged_id}`, {
        missing_ids: [args.staged_id],
      });
    }
    const remaining = crates.filter((c) => c.staged_id !== args.staged_id);
    if (remaining.length === 0) {
      clearStage(ctx.stateDir, lib.uuid);
    } else {
      const saved = saveStage(ctx.stateDir, { ...stage, crates: remaining });
      if (isSeratoError(saved)) return saved;
    }
    return ok({ discarded_ids: [args.staged_id] });
  } finally {
    lock.release();
  }
}
