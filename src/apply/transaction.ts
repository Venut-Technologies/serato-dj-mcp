import { DatabaseSync } from "node:sqlite";
import type { Warning } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { sameCrateName } from "../stage/name.js";
import type { StagedCrate } from "../stage/store.js";
import type { BackupPaths } from "./backup.js";
import {
  checkRootSchema,
  existingCrateId,
  findAnchors,
  resolveSpaceAssets,
  rootGeneration,
} from "./root.js";
import { checkSeratoClosed, type ProcessProbe, systemProbe } from "./serato.js";

/** Spec 5.4: SQLITE_BUSY becomes busy with retry_after_ms equal to this. */
export const BUSY_TIMEOUT_MS = 3000;

/** node:sqlite's extended code for a UNIQUE violation, measured 2026-09-14.
 *  The primary code 19 is shared with NOT NULL (1299), CHECK and FK, so only
 *  the extended code identifies a name collision (spec 5.4). */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export type AppliedCrate = {
  staged_id: string;
  name: string;
  container_id: number;
  track_count: number;
};

export type ApplyOutcome = { applied: AppliedCrate[]; revision: number; warnings: Warning[] };

export type ApplyInput = {
  rootPath: string;
  masterPath: string;
  libraryId: string;
  crates: StagedCrate[];
  stagedRootGeneration: string;
  backupPaths: BackupPaths;
  probe?: ProcessProbe;
};

export function applyCrates(input: ApplyInput): ApplyOutcome | SeratoError {
  const written = writeInTransaction(input);
  if (isSeratoError(written)) return written;
  return verifyCommitted(input, written) ?? written;
}

function writeInTransaction(input: ApplyInput): ApplyOutcome | SeratoError {
  const probe = input.probe ?? systemProbe;
  const notCommitted = (stage: string, message: string, extra: Record<string, unknown> = {}) =>
    err("write_failed_not_committed", message, { stage, ...extra });

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(input.rootPath);
  } catch (e) {
    return notCommitted("open", `cannot open root.sqlite: ${String(e)}`);
  }
  const rollback = () => {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      // A failed ROLLBACK leaves nothing to add: SQLite rolls back an open
      // transaction when the connection closes, which the finally does.
    }
  };

  try {
    // Explicit even though node:sqlite enables foreign keys by default: the
    // protocol must not depend on a binding's default (spec 5.4).
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      return err("busy", `root.sqlite is locked by another writer: ${String(e)}`, {
        retry_after_ms: BUSY_TIMEOUT_MS,
      });
    }

    // Spec 5.1.3: again, now that we hold the write lock. Serato may have
    // started between the caller's first check and this BEGIN.
    const running = checkSeratoClosed(input.masterPath, probe);
    if (running !== null) {
      rollback();
      return running;
    }
    const schema = checkRootSchema(db);
    if (schema !== null) {
      rollback();
      return schema;
    }
    const anchors = findAnchors(db);
    if (isSeratoError(anchors)) {
      rollback();
      return anchors;
    }

    const warnings: Warning[] = [];
    // P4 amendment 2: informational. What the crate actually depends on is
    // re-validated below instead.
    if (rootGeneration(db, input.rootPath, input.libraryId) !== input.stagedRootGeneration) {
      warnings.push({
        code: "root_generation_changed",
        message:
          "root.sqlite changed since these crates were staged; everything they depend on was re-checked and still holds",
        details: { staged_root_generation: input.stagedRootGeneration },
      });
    }

    for (let i = 0; i < input.crates.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (sameCrateName(input.crates[i].name, input.crates[j].name)) {
          rollback();
          return err(
            "invalid_crate_name",
            `two staged crates are both named "${input.crates[i].name}"`,
            {
              reason: "duplicate_in_batch",
              staged_ids: [input.crates[j].staged_id, input.crates[i].staged_id],
            },
          );
        }
      }
    }

    // Re-validation (decisions 2 and 7): name conflicts first, because a
    // conflict makes the whole batch meaningless regardless of tracks.
    const resolvedByCrate = new Map<string, Map<string, number>>();
    const unresolvable: number[] = [];
    for (const crate of input.crates) {
      const conflict = existingCrateId(db, anchors.rootContainerId, crate.name);
      if (conflict !== null) {
        rollback();
        return err("crate_name_conflict", `a crate named "${crate.name}" already exists`, {
          existing_container_id: conflict,
          crate_name: crate.name,
          staged_id: crate.staged_id,
        });
      }
      const { resolved, missing } = resolveSpaceAssets(
        db,
        anchors.spaceId,
        crate.tracks.map((t) => t.portable_id),
      );
      resolvedByCrate.set(crate.staged_id, resolved);
      const missingSet = new Set(missing);
      for (const t of crate.tracks)
        if (missingSet.has(t.portable_id)) unresolvable.push(t.track_id);
    }
    if (unresolvable.length > 0) {
      rollback();
      return err("write_refused", "some staged tracks are no longer in the Serato Library space", {
        reason: "tracks_no_longer_resolve",
        rejected_track_ids: [...new Set(unresolvable)],
      });
    }

    // Spec 5.5's foreign-key check is about THIS write, so it is a count before
    // and after rather than a demand for zero: a library that already carries
    // an orphan row would otherwise refuse every apply forever, over damage the
    // write did not cause. (The live root had none on 2026-09-15.)
    const foreignKeyViolations = () =>
      db.prepare("PRAGMA foreign_key_check(container)").all().length +
      db.prepare("PRAGMA foreign_key_check(container_asset)").all().length;
    const fkBefore = foreignKeyViolations();

    // (A) revision first. The space-revision triggers ASSIGN
    // space.revision := serato.revision under space.revision < serato.revision,
    // so bumping after the inserts would leave the space revision unmoved and
    // the crate invisible to Serato (spec 2.5, 5.4).
    db.exec("UPDATE serato SET revision = COALESCE(revision, 0) + 1");
    const { revision } = db.prepare("SELECT revision FROM serato").get() as { revision: number };

    const insertContainer = db.prepare(
      `INSERT INTO container (revision, parent_id, name, type, list_order, space_id, expanded, portable_id, color)
       VALUES (?, ?, ?, 1,
               (SELECT COALESCE(MAX(list_order), 0) + 1 FROM container WHERE parent_id = ?),
               ?, 0, '', NULL)`,
    );
    const insertTrack = db.prepare(
      "INSERT INTO container_asset (revision, container_id, space_asset_id, list_order) VALUES (?, ?, ?, ?)",
    );

    const applied: AppliedCrate[] = [];
    for (const crate of input.crates) {
      let containerId: number;
      try {
        // (B) no explicit id: AUTOINCREMENT keeps sqlite_sequence right, and an
        // explicit id could collide with ids Serato hands out later. The rowid
        // is read from THIS statement's result, before any other insert can
        // overwrite last_insert_rowid.
        containerId = Number(
          insertContainer.run(
            revision,
            anchors.rootContainerId,
            crate.name,
            anchors.rootContainerId,
            anchors.spaceId,
          ).lastInsertRowid,
        );
      } catch (e) {
        rollback();
        if ((e as { errcode?: number }).errcode === SQLITE_CONSTRAINT_UNIQUE) {
          return err("crate_name_conflict", `a crate named "${crate.name}" already exists`, {
            existing_container_id: existingCrateId(db, anchors.rootContainerId, crate.name),
            crate_name: crate.name,
            staged_id: crate.staged_id,
          });
        }
        throw e;
      }
      const resolved = resolvedByCrate.get(crate.staged_id) ?? new Map<string, number>();
      // (C) list_order 1..N in the staged order, which is the running order.
      crate.tracks.forEach((track, index) => {
        const spaceAssetId = resolved.get(track.portable_id);
        if (spaceAssetId === undefined) {
          throw new Error(`staged track ${track.portable_id} lost its resolution mid-transaction`);
        }
        insertTrack.run(revision, containerId, spaceAssetId, index + 1);
      });
      applied.push({
        staged_id: crate.staged_id,
        name: crate.name,
        container_id: containerId,
        track_count: crate.tracks.length,
      });
    }

    // Spec 5.5, before COMMIT: targeted checks instead of quick_check over the
    // whole database.
    const problems: string[] = [];
    const fkAfter = foreignKeyViolations();
    if (fkAfter > fkBefore) {
      problems.push(`foreign_key_check found ${fkAfter - fkBefore} new violation(s)`);
    }
    const space = db.prepare("SELECT revision FROM space WHERE id = ?").get(anchors.spaceId) as {
      revision: number;
    };
    if (space.revision !== revision) {
      problems.push(`space.revision is ${space.revision}, expected ${revision}`);
    }
    for (const a of applied) {
      const found = db
        .prepare("SELECT 1 FROM container WHERE id = ? AND type = 1 AND parent_id = ?")
        .get(a.container_id, anchors.rootContainerId);
      const { n } = db
        .prepare("SELECT count(*) AS n FROM container_asset WHERE container_id = ?")
        .get(a.container_id) as { n: number };
      if (found === undefined) problems.push(`container ${a.container_id} is not readable`);
      if (n !== a.track_count)
        problems.push(`container ${a.container_id} has ${n} tracks, expected ${a.track_count}`);
    }
    if (problems.length > 0) {
      rollback();
      return notCommitted(
        "verify_in_transaction",
        "the write did not check out and was rolled back",
        {
          problems,
        },
      );
    }

    try {
      db.exec("COMMIT");
    } catch (e) {
      rollback();
      return notCommitted("commit", `COMMIT failed and the write was rolled back: ${String(e)}`);
    }
    return { applied, revision, warnings };
  } catch (e) {
    rollback();
    return notCommitted("transaction", `the write failed and was rolled back: ${String(e)}`);
  } finally {
    db.close();
  }
}

/**
 * Spec 5.5, after COMMIT, on a NEW connection -- the only thing that makes
 * committed_unverified a reachable state rather than a hope. A failure here
 * means the data may well be in the file; the caller gets the backup paths.
 */
function verifyCommitted(input: ApplyInput, outcome: ApplyOutcome): SeratoError | null {
  const unverified = (message: string, problems: string[] = []) =>
    err("write_failed_committed_unverified", message, {
      stage: "verify_after_commit",
      backup_paths: input.backupPaths,
      problems,
    });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(input.rootPath, { readOnly: true });
    const problems: string[] = [];
    const { revision } = db.prepare("SELECT revision FROM serato").get() as { revision: number };
    if (revision !== outcome.revision)
      problems.push(`serato.revision is ${revision}, expected ${outcome.revision}`);
    for (const a of outcome.applied) {
      const row = db.prepare("SELECT name FROM container WHERE id = ?").get(a.container_id) as
        | { name: string }
        | undefined;
      const { n } = db
        .prepare("SELECT count(*) AS n FROM container_asset WHERE container_id = ?")
        .get(a.container_id) as { n: number };
      if (row?.name !== a.name)
        problems.push(`container ${a.container_id} does not read back as "${a.name}"`);
      if (n !== a.track_count) problems.push(`container ${a.container_id} reads back ${n} tracks`);
    }
    return problems.length === 0
      ? null
      : unverified("the committed write did not read back", problems);
  } catch (e) {
    return unverified(`the committed write could not be read back: ${String(e)}`);
  } finally {
    db?.close();
  }
}
