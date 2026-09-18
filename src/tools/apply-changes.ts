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
  "or any staged track is gone from the library, nothing is written and the stage is kept. " +
  "Before calling it with confirm: true, show the user preview_changes and get their explicit " +
  "go-ahead. New crates do not appear in list_crates or the other read tools until Serato has " +
  "been started and has synced.";

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

  const lock = acquireWriteLock(ctx.stateDir, lib.uuid);
  if (isSeratoError(lock)) return lock;
  try {
    // The stage must be read by the same holder of the lock that later
    // clears it. Reading it before the lock leaves a window where a crate
    // staged in that gap is applied over and then deleted by clearStage
    // below, without ever having been applied itself.
    const stage = loadStage(ctx.stateDir, lib.uuid);
    if (isSeratoError(stage)) return stage;
    if (stage === null || stage.crates.length === 0) {
      return ok({ applied: [], backup_paths: null, restart_required: false });
    }

    // Preconditions on root.sqlite itself, checked before anything else: it
    // must exist, and it must carry no live journal from a write in progress
    // or one that was interrupted.
    if (!existsSync(rootPath)) {
      return err("write_refused", "this library has no root.sqlite to write crates into", {
        reason: "root_missing",
        rejected_track_ids: [],
      });
    }
    if (existsSync(`${rootPath}-journal`)) {
      return err(
        "write_refused",
        "root.sqlite-journal exists: either Serato is writing the library right now, or a " +
          "write was interrupted. Quit Serato and retry; if it persists with Serato closed, " +
          "start and quit Serato once so SQLite can roll it back. Do not delete the journal on " +
          "its own.",
        {
          reason: "root_journal_present",
          rejected_track_ids: [],
        },
      );
    }

    // Checked here first -- before the backup, so a running Serato costs
    // nothing. The transaction checks again after BEGIN IMMEDIATE.
    const running = checkSeratoClosed(lib.masterPath, ctx.probe);
    if (running !== null) return running;

    // Fail-closed: no write proceeds without a verified backup.
    const backupPaths = await backupLibrary(lib.path, ctx.stateDir, lib.uuid);
    if (isSeratoError(backupPaths)) return backupPaths;

    // Intent recorded before BEGIN (see writeIntent's own doc for why).
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
      // committed_unverified is the one failure that may well be in the
      // file, so it keeps its intent rather than being marked aborted --
      // and the caller is told plainly not to retry over it.
      if (outcome.error.code === "write_failed_committed_unverified") {
        return {
          error: {
            ...outcome.error,
            message:
              `${outcome.error.message} -- the crates are most likely written. Do not retry ` +
              "apply_changes; start Serato to check, and restore from backup_paths only if " +
              "they are wrong.",
          },
        };
      }
      // Every other failure is known not committed: say so in the manifest.
      const aborted = markAborted(ctx.stateDir, lib.uuid, opId, outcome.error.code);
      if (isSeratoError(aborted)) {
        // The original failure is still the real answer; the manifest just
        // could not be told about it.
        return {
          error: {
            ...outcome.error,
            details: { ...outcome.error.details, manifest_not_updated: true },
          },
        };
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
    try {
      clearStage(ctx.stateDir, lib.uuid);
    } catch (e) {
      // The write already succeeded and was verified: failing the call now
      // would invite a retry that the name-conflict check then refuses.
      // discard_changes can still clear the stage later.
      warnings.push({
        code: "stage_not_cleared",
        message:
          "the crates were written, but the stage could not be removed; discard_changes will clear it",
        details: { error: e instanceof Error ? e.message : String(e) },
      });
    }
    return ok(
      { applied: outcome.applied, backup_paths: backupPaths, restart_required: true },
      undefined,
      warnings,
    );
  } finally {
    lock.release();
  }
}
