import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { manifestPath, readManifest } from "../../src/apply/manifest.js";
import { acquireWriteLock } from "../../src/apply/mutex.js";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { isSeratoError } from "../../src/errors.js";
import { loadStage, stagePath } from "../../src/stage/store.js";
import { applyChanges } from "../../src/tools/apply-changes.js";
import { searchTracks } from "../../src/tools/search-tracks.js";
import { stageCrate } from "../../src/tools/stage-crate.js";
import { makeLibraryFixture, ROOT_ANCHOR_CONTAINER_ID, ROOT_SPACE_ID } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-apply-"));
const nobody: ProcessProbe = { isAlive: () => false, nameOf: () => null };

async function stagedLibrary(crateNames: string[] = ["Gigs 2026"]) {
  const dir = tmp();
  const { masterPath, rootPath } = makeLibraryFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "Rain" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "Storm" },
    ],
  });
  const ctx = { library: dir, roots: [], cacheDir: tmp(), stateDir: tmp(), probe: nobody };
  const found = await searchTracks({ fields: ["title"] }, ctx);
  if (isSeratoError(found)) throw new Error("unexpected error");
  const ids = found.tracks.map((t) => t.id as number);
  let libraryId = "";
  for (const name of crateNames) {
    const r = await stageCrate({ name, track_ids: ids }, ctx);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    libraryId = r.library_id;
  }
  const crates = () => {
    const db = new DatabaseSync(rootPath, { readOnly: true });
    try {
      return db
        .prepare("SELECT id, name FROM container WHERE parent_id = ? AND type = 1 ORDER BY id")
        .all(ROOT_ANCHOR_CONTAINER_ID) as { id: number; name: string }[];
    } finally {
      db.close();
    }
  };
  return { dir, ctx, masterPath, rootPath, libraryId, crates };
}

describe("apply_changes", () => {
  it("writes the staged crate, backs up first, records it, and clears the stage", async () => {
    const { ctx, crates, libraryId } = await stagedLibrary();
    const r = await applyChanges({ confirm: true }, ctx);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);

    expect(r.applied).toEqual([
      {
        staged_id: expect.any(String),
        name: "Gigs 2026",
        container_id: expect.any(Number),
        track_count: 2,
      },
    ]);
    expect(r.restart_required).toBe(true);
    expect(crates().map((c) => c.name)).toEqual(["Gigs 2026"]);
    expect(r.backup_paths !== null && existsSync(r.backup_paths.root)).toBe(true);
    expect(r.backup_paths !== null && existsSync(r.backup_paths.master)).toBe(true);
    const [entry] = readManifest(ctx.stateDir, libraryId);
    expect(entry.commit_state).toBe("committed");
    expect(entry.crates[0].container_id).toBe(r.applied[0].container_id);
    // Decision 9: what was applied leaves the stage.
    expect(loadStage(ctx.stateDir, libraryId)).toBeNull();
  });

  it("refuses without confirm: true, writing nothing", async () => {
    const { ctx, crates } = await stagedLibrary();
    const r = await applyChanges({ confirm: false }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("invalid_argument");
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("confirm_required");
    expect(crates()).toEqual([]);
  });

  // Spec 4.2: an empty stage is a success with empty arrays -- and it must not
  // take a backup of a library it is not going to write.
  it("treats an empty stage as success without touching anything", async () => {
    const { ctx } = await stagedLibrary([]);
    const r = await applyChanges({ confirm: true }, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.applied).toEqual([]);
    expect(r.backup_paths).toBeNull();
    expect(r.restart_required).toBe(false);
    expect(existsSync(join(ctx.stateDir, "backups"))).toBe(false);
  });

  // Spec 5.1.3: refused before the backup, so a running Serato costs nothing.
  it("refuses while Serato is running, before taking any backup", async () => {
    const { ctx, masterPath, crates, libraryId } = await stagedLibrary();
    const m = new DatabaseSync(masterPath);
    m.prepare(
      "INSERT INTO lock (lock_policy, owner_process_id, owner_process_name) VALUES (1, 500, 'Serato DJ Lite')",
    ).run();
    m.close();
    const running: ProcessProbe = { isAlive: (pid) => pid === 500, nameOf: () => "Serato DJ Lite" };
    const r = await applyChanges({ confirm: true }, { ...ctx, probe: running });
    expect(isSeratoError(r) && r.error.code).toBe("serato_running");
    expect(crates()).toEqual([]);
    expect(existsSync(join(ctx.stateDir, "backups"))).toBe(false);
    const stage = loadStage(ctx.stateDir, libraryId);
    if (stage === null || isSeratoError(stage)) throw new Error("the stage should have survived");
    expect(stage.crates).toHaveLength(1);
  });

  // Spec 5.1.2: a journal next to root.sqlite means an unfinished transaction.
  it("refuses when root.sqlite has a hot journal", async () => {
    const { ctx, rootPath } = await stagedLibrary();
    writeFileSync(`${rootPath}-journal`, "x");
    const before = readFileSync(rootPath);
    const r = await applyChanges({ confirm: true }, ctx);
    expect(isSeratoError(r) && r.error.details?.reason).toBe("root_journal_present");
    // Checked by bytes, not through SQLite: any connection, even a read-only
    // one, would try to roll that journal back. The journal stays as found,
    // and the refusal comes before the backup.
    expect(readFileSync(rootPath).equals(before)).toBe(true);
    expect(readFileSync(`${rootPath}-journal`, "utf8")).toBe("x");
    expect(readdirSync(ctx.stateDir)).not.toContain("backups");
  });

  // Decision 9: a failed apply leaves the stage untouched, and the manifest
  // records the attempt as aborted rather than as a crash-like intent.
  it("keeps the stage and records the abort when the transaction refuses", async () => {
    const { ctx, rootPath, crates, libraryId } = await stagedLibrary();
    const db = new DatabaseSync(rootPath);
    db.prepare(
      "INSERT INTO container (revision, parent_id, name, type, list_order, space_id) VALUES (10, ?, 'GIGS 2026', 1, 5, ?)",
    ).run(ROOT_ANCHOR_CONTAINER_ID, ROOT_SPACE_ID);
    db.close();
    const r = await applyChanges({ confirm: true }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("crate_name_conflict");
    expect(crates().map((c) => c.name)).toEqual(["GIGS 2026"]);
    const stage = loadStage(ctx.stateDir, libraryId);
    if (stage === null || isSeratoError(stage)) throw new Error("the stage should have survived");
    expect(stage.crates).toHaveLength(1);
    const [entry] = readManifest(ctx.stateDir, libraryId);
    expect(entry.commit_state).toBe("aborted");
  });

  it("reports busy when another instance holds the write lock", async () => {
    const { ctx, libraryId, crates } = await stagedLibrary();
    const held = acquireWriteLock(ctx.stateDir, libraryId);
    if (isSeratoError(held)) throw new Error("unexpected error");
    try {
      const r = await applyChanges({ confirm: true }, ctx);
      expect(isSeratoError(r) && r.error.code).toBe("busy");
    } finally {
      held.release();
    }
    expect(crates()).toEqual([]);
    expect(readdirSync(ctx.stateDir)).not.toContain("backups");
  });

  // Ruling 10 part A.3: the stage must be read only after the lock is held,
  // by the same call that will clear it -- proven here by making the stage
  // unreadable and showing that a held lock reports busy rather than reading
  // (and reporting on) that corruption.
  it("reports busy rather than reading a corrupted stage when the lock is held", async () => {
    const { ctx, libraryId, crates } = await stagedLibrary();
    writeFileSync(stagePath(ctx.stateDir, libraryId), "{not json");
    const held = acquireWriteLock(ctx.stateDir, libraryId);
    if (isSeratoError(held)) throw new Error("unexpected error");
    try {
      const r = await applyChanges({ confirm: true }, ctx);
      expect(isSeratoError(r) && r.error.code).toBe("busy");
    } finally {
      held.release();
    }
    expect(crates()).toEqual([]);
  });

  it("applies several staged crates in one go", async () => {
    const { ctx, crates } = await stagedLibrary(["A", "B"]);
    const r = await applyChanges({ confirm: true }, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.applied.map((a) => a.name)).toEqual(["A", "B"]);
    expect(crates().map((c) => c.name)).toEqual(["A", "B"]);
  });

  // Inserts a lock row so checkSeratoClosed actually consults the probe
  // instead of short-circuiting on an empty lock table.
  function lockRow(masterPath: string) {
    const m = new DatabaseSync(masterPath);
    m.prepare(
      "INSERT INTO lock (lock_policy, owner_process_id, owner_process_name) VALUES (1, 500, 'Serato DJ Lite')",
    ).run();
    m.close();
  }

  // A1: mutant removes `if (isSeratoError(intent)) return intent;`. Without
  // it, a manifest failure is silently ignored and the crate gets written
  // anyway, with nothing recording that it was ever attempted.
  it("A1: reports write_failed_not_committed and writes nothing when the manifest cannot be created", async () => {
    const { ctx, crates, libraryId } = await stagedLibrary();
    writeFileSync(join(ctx.stateDir, "manifests"), "block");
    const r = await applyChanges({ confirm: true }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("write_failed_not_committed");
    if (isSeratoError(r)) expect(r.error.details?.stage).toBe("manifest");
    expect(crates()).toEqual([]);
    const stage = loadStage(ctx.stateDir, libraryId);
    if (stage === null || isSeratoError(stage)) throw new Error("the stage should have survived");
    expect(stage.crates).toHaveLength(1);
  });

  // A2: mutant drops the `!== "write_failed_committed_unverified"` guard, so
  // markAborted runs even for the one failure that may well be in the file --
  // mislabelling it as aborted when it is really unknown.
  it("A2: keeps the manifest entry as intent, not aborted, when the commit cannot be verified", async () => {
    const { ctx, rootPath, libraryId } = await stagedLibrary();
    const db = new DatabaseSync(rootPath);
    db.exec(
      "CREATE TRIGGER mangle AFTER INSERT ON container WHEN new.name = 'Gigs 2026' " +
        "BEGIN UPDATE container SET name = 'Mangled' WHERE id = new.id; END",
    );
    db.close();
    const r = await applyChanges({ confirm: true }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("write_failed_committed_unverified");
    const [entry] = readManifest(ctx.stateDir, libraryId);
    expect(entry.commit_state).toBe("intent");
    const stage = loadStage(ctx.stateDir, libraryId);
    if (stage === null || isSeratoError(stage)) throw new Error("the stage should have survived");
    expect(stage.crates).toHaveLength(1);
  });

  // A3: warnings from the transaction (here, root_generation_changed) must
  // reach the caller on a successful outcome, not be dropped on the way to
  // ok().
  it("A3: passes root_generation_changed through to a successful outcome's warnings", async () => {
    const { ctx, rootPath, crates } = await stagedLibrary();
    const future = new Date(Date.now() + 60_000);
    utimesSync(rootPath, future, future);
    const r = await applyChanges({ confirm: true }, ctx);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.warnings).toEqual([expect.objectContaining({ code: "root_generation_changed" })]);
    expect(crates().map((c) => c.name)).toEqual(["Gigs 2026"]);
  });

  // A4: markCommitted's own failure must still surface as a warning on an
  // otherwise successful apply. The probe is consulted inside the
  // transaction (spec 5.1.3's second check), by which point writeIntent has
  // already created the manifest file -- corrupting it there, but not
  // before, simulates the manifest becoming unwritable between intent and
  // commit without ever failing writeIntent itself.
  it("A4: emits manifest_not_updated and still clears the stage when markCommitted fails", async () => {
    const { ctx, masterPath, libraryId, crates } = await stagedLibrary();
    lockRow(masterPath);
    const mPath = manifestPath(ctx.stateDir, libraryId);
    const probe: ProcessProbe = {
      isAlive: () => {
        if (existsSync(mPath)) writeFileSync(mPath, "{not json");
        return false;
      },
      nameOf: () => null,
    };
    const r = await applyChanges({ confirm: true }, { ...ctx, probe });
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.warnings).toEqual([expect.objectContaining({ code: "manifest_not_updated" })]);
    expect(crates().map((c) => c.name)).toEqual(["Gigs 2026"]);
    expect(loadStage(ctx.stateDir, libraryId)).toBeNull();
  });

  // A5: clearStage (an rmSync) can throw after COMMIT. The write already
  // succeeded and was verified, so that must come back as a warning, not a
  // failure that invites a retry the name-conflict check would then refuse.
  it("A5: reports stage_not_cleared but still reports success when the stage cannot be removed", async () => {
    const { ctx, masterPath, crates } = await stagedLibrary();
    lockRow(masterPath);
    const stageDir = join(ctx.stateDir, "stage");
    const probe: ProcessProbe = {
      isAlive: () => {
        chmodSync(stageDir, 0o555);
        return false;
      },
      nameOf: () => null,
    };
    try {
      const r = await applyChanges({ confirm: true }, { ...ctx, probe });
      if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
      expect(r.warnings).toEqual([expect.objectContaining({ code: "stage_not_cleared" })]);
      expect(crates().map((c) => c.name)).toEqual(["Gigs 2026"]);
    } finally {
      chmodSync(stageDir, 0o755);
    }
  });

  // A6: if markAborted itself fails, the manifest could not be told about
  // the abort -- but the original refusal (crate_name_conflict here) is
  // still the real answer, now carrying that fact in its details.
  it("A6: adds manifest_not_updated to a transaction refusal's details when markAborted also fails", async () => {
    const { ctx, rootPath, masterPath, libraryId, crates } = await stagedLibrary();
    const db = new DatabaseSync(rootPath);
    db.prepare(
      "INSERT INTO container (revision, parent_id, name, type, list_order, space_id) VALUES (10, ?, 'GIGS 2026', 1, 5, ?)",
    ).run(ROOT_ANCHOR_CONTAINER_ID, ROOT_SPACE_ID);
    db.close();
    lockRow(masterPath);
    const mPath = manifestPath(ctx.stateDir, libraryId);
    const probe: ProcessProbe = {
      isAlive: () => {
        if (existsSync(mPath)) writeFileSync(mPath, "{not json");
        return false;
      },
      nameOf: () => null,
    };
    const r = await applyChanges({ confirm: true }, { ...ctx, probe });
    expect(isSeratoError(r) && r.error.code).toBe("crate_name_conflict");
    if (isSeratoError(r)) expect(r.error.details?.manifest_not_updated).toBe(true);
    expect(crates().map((c) => c.name)).toEqual(["GIGS 2026"]);
  });
});
