import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type BackupPaths, backupLibrary } from "../apply/backup.js";
import { markAborted, markCommitted, writeIntent } from "../apply/manifest.js";
import { acquireWriteLock } from "../apply/mutex.js";
import { checkSeratoClosed, type ProcessProbe } from "../apply/serato.js";
import { type AppliedCrate, applyCrates } from "../apply/transaction.js";
import { parseToolArgs } from "../args.js";
import { resolveLibrary } from "../discovery/index.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { clearStage, loadStage } from "../stage/store.js";
import type { WriteCtx } from "./stage-crate.js";

export type ApplyCtx = WriteCtx & { probe?: ProcessProbe };

export const applyChangesInput = z
  .object({ confirm: z.boolean() })
  .refine((v) => v.confirm === true, {
    error: "apply_changes writes to the library and needs confirm: true",
    params: { reason: "confirm_required" },
  });

export const applyChangesOutput = z.object({
  applied: z.array(
    z.object({
      staged_id: z.string(),
      name: z.string(),
      container_id: z.number(),
      track_count: z.number(),
    }),
  ),
  backup_paths: z.object({ root: z.string(), master: z.string() }).nullable(),
  restart_required: z.boolean(),
  warnings: z.array(warningSchema).optional(),
});

export const applyChangesDescription =
  "Write every staged crate into the Serato library, all or nothing. Serato must be closed: " +
  "the call is refused while it runs. Both library databases are backed up first and the paths " +
  "are returned -- there is no undo tool, restoring means copying those files back with Serato " +
  "closed. Serato shows the new crates after it is started again. If any crate's name is taken " +
  "or any staged track is gone from the library, nothing is written and the stage is kept.";

export async function applyChanges(
  raw: unknown,
  ctx: ApplyCtx,
): Promise<
  | ({
      applied: AppliedCrate[];
      backup_paths: BackupPaths | null;
      restart_required: boolean;
    } & { warnings?: Warning[] })
  | SeratoError
> {
  const args = parseToolArgs(applyChangesInput, raw);
  if (isSeratoError(args)) return args;

  const lib = resolveLibrary({ library: ctx.library, roots: ctx.roots });
  if (isSeratoError(lib)) return lib;
  const rootPath = join(lib.path, "root.sqlite");

  const stage = loadStage(ctx.stateDir, lib.uuid);
  if (isSeratoError(stage)) return stage;
  if (stage === null || stage.crates.length === 0) {
    return ok({ applied: [], backup_paths: null, restart_required: false });
  }

  const lock = acquireWriteLock(ctx.stateDir, lib.uuid);
  if (isSeratoError(lock)) return lock;
  try {
    // Spec 5.1.1 and 5.1.2.
    if (!existsSync(rootPath)) {
      return err("write_refused", "this library has no root.sqlite to write crates into", {
        reason: "root_missing",
        rejected_track_ids: [],
      });
    }
    if (existsSync(`${rootPath}-journal`)) {
      return err(
        "write_refused",
        "root.sqlite has a hot journal: a transaction was left unfinished",
        {
          reason: "root_journal_present",
          rejected_track_ids: [],
        },
      );
    }

    // Spec 5.1.3, first check -- before the backup, so a running Serato costs
    // nothing. The transaction checks again after BEGIN IMMEDIATE.
    const running = checkSeratoClosed(lib.masterPath, ctx.probe);
    if (running !== null) return running;

    // Spec 5.1.4: fail-closed.
    const backupPaths = await backupLibrary(lib.path, ctx.stateDir, lib.uuid);
    if (isSeratoError(backupPaths)) return backupPaths;

    // Spec 5.1.5: intent before BEGIN.
    const opId = randomUUID();
    const intent = writeIntent(ctx.stateDir, {
      schema_version: 1,
      op_id: opId,
      ts: new Date().toISOString(),
      library_id: lib.uuid,
      crates: stage.crates.map((c) => ({
        staged_id: c.staged_id,
        name: c.name,
        track_count: c.tracks.length,
        container_id: null,
      })),
      backup_paths: backupPaths,
      commit_state: "intent",
    });
    if (isSeratoError(intent)) return intent;

    const outcome = applyCrates({
      rootPath,
      masterPath: lib.masterPath,
      libraryId: lib.uuid,
      crates: stage.crates,
      stagedRootGeneration: stage.root_generation,
      backupPaths,
      probe: ctx.probe,
    });
    if (isSeratoError(outcome)) {
      // Known not committed: say so in the manifest. committed_unverified is
      // the one failure that may well be in the file, so it keeps its intent.
      if (outcome.error.code !== "write_failed_committed_unverified") {
        markAborted(ctx.stateDir, lib.uuid, opId, outcome.error.code);
      }
      return outcome;
    }

    const warnings = [...outcome.warnings];
    const committed = markCommitted(
      ctx.stateDir,
      lib.uuid,
      opId,
      new Map(outcome.applied.map((a) => [a.staged_id, a.container_id])),
    );
    if (isSeratoError(committed)) {
      // The write itself succeeded and was verified; failing the call now
      // would invite a retry that the name-conflict check then refuses.
      warnings.push({
        code: "manifest_not_updated",
        message: "the crates were written, but the manifest could not be marked committed",
        details: { op_id: opId },
      });
    }
    clearStage(ctx.stateDir, lib.uuid);
    return ok(
      { applied: outcome.applied, backup_paths: backupPaths, restart_required: true },
      undefined,
      warnings,
    );
  } finally {
    lock.release();
  }
}
