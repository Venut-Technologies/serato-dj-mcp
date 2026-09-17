import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { err, type SeratoError } from "../errors.js";

export const STAGE_SCHEMA_VERSION = 1;

export type StagedTrack = { track_id: number; portable_id: string; title: string; artist: string };

export type StagedCrate = {
  staged_id: string;
  name: string;
  tracks: StagedTrack[];
  staged_at: string;
};

/**
 * What survives between staging and applying. It stores portable_id rather
 * than the master snapshot's asset.id (spec 3.4): an id only means something
 * against one snapshot, while apply re-resolves portable_id against root.sqlite
 * inside its own transaction (P4 amendment 2). track_id, title and artist are
 * kept only so preview_changes can show a human what will be written.
 */
export type Stage = {
  schema_version: 1;
  library_id: string;
  library_path: string;
  generation: string;
  root_generation: string;
  crates: StagedCrate[];
};

/**
 * The full shape of a stage file, checked field by field on every load.
 *
 * Before this, only `Array.isArray(crates)` and `typeof library_id ===
 * "string"` were checked, so `{"crates":[{}]}` passed loadStage and reached
 * previewChanges/discardChanges as a `Stage` with `undefined` where a track's
 * `portable_id` should be -- previewChanges threw a TypeError, and
 * discardChanges returned `discarded_ids: [undefined]`, which fails its own
 * output schema (review finding, Ruling 10 part B). tracks.min(1) matches
 * spec 5.8: Serato deletes an empty crate, so a staged one with no tracks is
 * already the wrong shape, not merely an edge case.
 */
const stagedTrackSchema = z.object({
  track_id: z.number().int(),
  portable_id: z.string().min(1),
  title: z.string(),
  artist: z.string(),
});

const stagedCrateSchema = z.object({
  staged_id: z.string().min(1),
  name: z.string().min(1),
  tracks: z.array(stagedTrackSchema).min(1),
  staged_at: z.string(),
});

const stageSchema = z.object({
  schema_version: z.literal(1),
  library_id: z.string().min(1),
  library_path: z.string(),
  generation: z.string(),
  root_generation: z.string(),
  crates: z.array(stagedCrateSchema),
});

export function stagePath(stateDir: string, libraryId: string): string {
  return join(stateDir, "stage", `${libraryId}.json`);
}

/**
 * Temp file, fsync, rename, fsync the directory. Without the last fsync a
 * crash right after the rename can leave the directory entry pointing at the
 * old file on some filesystems; without the first, at a zero-length one.
 * Throws -- callers turn it into a value at their own boundary.
 */
export function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  err("write_refused", message, { reason, rejected_track_ids: [], ...extra });

export function loadStage(stateDir: string, libraryId: string): Stage | null | SeratoError {
  const path = stagePath(stateDir, libraryId);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // preview_changes reads without the write lock, so the file can be
    // deleted between the existsSync above and this read -- by
    // apply_changes/discard_changes in another instance, clearing a stage
    // that really is now empty. That is not the user's staged work in an
    // unreadable state, so it is treated as no stage rather than refused.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // The user's staged work, unreadable. Refused loudly rather than treated
    // as empty, which would discard it without a word.
    return refuse("stage_unreadable", `the stage file cannot be read: ${String(e)}`, { path });
  }
  const s = parsed as Partial<Stage>;
  if (s === null || typeof s !== "object" || s.schema_version !== STAGE_SCHEMA_VERSION) {
    return refuse("stage_version", "the stage file was written by an incompatible version", {
      path,
      found: (s as { schema_version?: unknown } | null)?.schema_version ?? null,
    });
  }
  const result = stageSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    return refuse("stage_unreadable", `the stage file has an invalid shape: ${issues}`, {
      path,
      issues,
    });
  }
  return result.data;
}

export function saveStage(stateDir: string, stage: Stage): true | SeratoError {
  try {
    writeFileAtomic(stagePath(stateDir, stage.library_id), `${JSON.stringify(stage, null, 2)}\n`);
    return true;
  } catch (e) {
    return refuse("stage_unwritable", `the stage could not be saved: ${String(e)}`);
  }
}

export function clearStage(stateDir: string, libraryId: string): void {
  rmSync(stagePath(stateDir, libraryId), { force: true });
}
