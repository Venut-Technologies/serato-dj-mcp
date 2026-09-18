import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rootGeneration } from "../../src/apply/root.js";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { isSqliteBusy } from "../../src/apply/sqlite.js";
import { type ApplyInput, applyCrates, verifyCommitted } from "../../src/apply/transaction.js";
import { isSeratoError } from "../../src/errors.js";
import type { StagedCrate } from "../../src/stage/store.js";
import {
  makeLibraryFixture,
  ROOT_ANCHOR_CONTAINER_ID,
  ROOT_BASE_REVISION,
  ROOT_SPACE_ID,
} from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-tx-"));
const nobodyRunning: ProcessProbe = { isAlive: () => false, nameOf: () => null };

const TRACKS = [
  { externalId: 1, portableId: "Users/x/1.flac", name: "One" },
  { externalId: 2, portableId: "Users/x/2.flac", name: "Two" },
  { externalId: 3, portableId: "Users/x/3.flac", name: "Three" },
];

const crate = (stagedId: string, name: string, portableIds: string[]): StagedCrate => ({
  staged_id: stagedId,
  name,
  tracks: portableIds.map((p, i) => ({ track_id: i + 1, portable_id: p, title: p, artist: "" })),
  staged_at: "2026-09-14T10:00:00.000Z",
});

function setup(opts: { crates?: { id: number; name: string; trackExternalIds: number[] }[] } = {}) {
  const dir = tmp();
  const { masterPath, rootPath } = makeLibraryFixture(dir, { tracks: TRACKS, crates: opts.crates });
  const probe = new DatabaseSync(rootPath, { readOnly: true });
  const generation = rootGeneration(probe, rootPath, "lib000000001");
  probe.close();
  const input = (crates: StagedCrate[], over: Partial<ApplyInput> = {}): ApplyInput => ({
    rootPath,
    masterPath,
    libraryId: "lib000000001",
    crates,
    stagedRootGeneration: generation,
    backupPaths: { root: "/b/root.sqlite", master: "/b/master.sqlite" },
    probe: nobodyRunning,
    ...over,
  });
  const read = <T>(sql: string, ...params: (string | number)[]) => {
    const db = new DatabaseSync(rootPath, { readOnly: true });
    try {
      return db.prepare(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  };
  return { rootPath, masterPath, input, read };
}

const revisions = (read: ReturnType<typeof setup>["read"]) =>
  read<{ sr: number; spr: number }>(
    "SELECT (SELECT revision FROM serato) AS sr, (SELECT revision FROM space WHERE id = ?) AS spr",
    ROOT_SPACE_ID,
  )[0];

describe("applyCrates", () => {
  it("creates the crate under the anchor, tracks in order, and moves both revisions", () => {
    const { input, read } = setup();
    const r = applyCrates(input([crate("s1", "Gigs 2026", ["Users/x/3.flac", "Users/x/1.flac"])]));
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);

    expect(r.revision).toBe(ROOT_BASE_REVISION + 1);
    expect(r.applied).toEqual([
      { staged_id: "s1", name: "Gigs 2026", container_id: expect.any(Number), track_count: 2 },
    ]);
    const rows = read<{ name: string; parent_id: number; type: number; space_id: number }>(
      "SELECT name, parent_id, type, space_id FROM container WHERE id = ?",
      r.applied[0].container_id,
    );
    expect(rows).toEqual([
      { name: "Gigs 2026", parent_id: ROOT_ANCHOR_CONTAINER_ID, type: 1, space_id: ROOT_SPACE_ID },
    ]);
    // The staged order is the running order the DJ asked for.
    const order = read<{ portable_id: string; list_order: number }>(
      `SELECT a.portable_id, ca.list_order FROM container_asset ca
         JOIN space_asset sa ON sa.id = ca.space_asset_id JOIN asset a ON a.id = sa.asset_id
        WHERE ca.container_id = ? ORDER BY ca.list_order`,
      r.applied[0].container_id,
    );
    expect(order).toEqual([
      { portable_id: "Users/x/3.flac", list_order: 1 },
      { portable_id: "Users/x/1.flac", list_order: 2 },
    ]);
    // Without the space revision moving, the crate lies in the database and
    // never appears in Serato -- a silent failure (see docs/serato-4x-notes.md
    // on why the revision order matters).
    expect(revisions(read)).toEqual({ sr: ROOT_BASE_REVISION + 1, spr: ROOT_BASE_REVISION + 1 });
  });

  // One transaction, one revision, for the whole batch.
  it("writes several crates in one transaction with a single revision bump", () => {
    const { input, read } = setup();
    const r = applyCrates(
      input([crate("s1", "A", ["Users/x/1.flac"]), crate("s2", "B", ["Users/x/2.flac"])]),
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.applied.map((a) => a.name)).toEqual(["A", "B"]);
    expect(revisions(read).sr).toBe(ROOT_BASE_REVISION + 1);
  });

  it("places a new crate after its existing siblings", () => {
    const { input, read } = setup({
      crates: [{ id: 20, name: "Existing", trackExternalIds: [1] }],
    });
    const r = applyCrates(input([crate("s1", "New", ["Users/x/2.flac"])]));
    if (isSeratoError(r)) throw new Error("unexpected error");
    const [{ max }] = read<{ max: number }>(
      "SELECT max(list_order) AS max FROM container WHERE parent_id = ? AND id <> ?",
      ROOT_ANCHOR_CONTAINER_ID,
      r.applied[0].container_id,
    );
    const [{ list_order }] = read<{ list_order: number }>(
      "SELECT list_order FROM container WHERE id = ?",
      r.applied[0].container_id,
    );
    expect(list_order).toBe(max + 1);
  });

  // Same rule again: a conflict on ANY crate refuses the whole batch, and
  // nothing -- not the first crate, not the revision -- reaches the file.
  it("writes nothing at all when one crate of the batch conflicts, ignoring case", () => {
    const { input, read } = setup({
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [1] }],
    });
    const before = read<{ n: number }>("SELECT count(*) AS n FROM container")[0].n;
    const r = applyCrates(
      input([
        crate("s1", "Fresh", ["Users/x/2.flac"]),
        crate("s2", "gIGS 2026", ["Users/x/3.flac"]),
      ]),
    );
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("crate_name_conflict");
      expect(r.error.details?.existing_container_id).toEqual(expect.any(Number));
    }
    expect(read<{ n: number }>("SELECT count(*) AS n FROM container")[0].n).toBe(before);
    expect(revisions(read).sr).toBe(ROOT_BASE_REVISION);
  });

  // Decisions 2 and 7: apply re-resolves every portable_id inside the
  // transaction. A track that vanished since staging refuses the batch.
  it("refuses the whole batch when a staged track no longer resolves", () => {
    const { input, read, rootPath } = setup();
    const db = new DatabaseSync(rootPath);
    db.exec(
      "UPDATE asset SET portable_id = 'Users/x/moved.flac' WHERE portable_id = 'Users/x/2.flac'",
    );
    db.close();
    const r = applyCrates(input([crate("s1", "A", ["Users/x/1.flac", "Users/x/2.flac"])]));
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_refused");
      expect(r.error.details?.reason).toBe("tracks_no_longer_resolve");
      expect(r.error.details?.rejected_track_ids).toEqual([2]);
    }
    expect(revisions(read).sr).toBe(ROOT_BASE_REVISION);
  });

  // The foreign-key check runs on THIS write. A library that already
  // carries an orphan row must not refuse every apply forever over damage
  // the write did not cause.
  it("applies into a library that already carries an orphan row", () => {
    const { input, read, rootPath } = setup();
    const db = new DatabaseSync(rootPath);
    db.exec("PRAGMA foreign_keys = OFF");
    const [{ id }] = db.prepare("SELECT id FROM space_asset LIMIT 1").all() as { id: number }[];
    db.prepare(
      "INSERT INTO container_asset (revision, container_id, space_asset_id, list_order) VALUES (1, 9999, ?, 1)",
    ).run(id);
    db.close();
    const r = applyCrates(input([crate("s1", "A", ["Users/x/1.flac"])]));
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    const orphans = read<{ n: number }>(
      "SELECT count(*) AS n FROM pragma_foreign_key_check('container_asset')",
    );
    expect(orphans[0].n).toBe(1);
  });

  // A changed root_generation is reported, not refused -- Serato writes
  // root.sqlite mid-session (a DBv2 export, measured) without touching
  // anything a crate depends on.
  it("applies despite a changed root_generation and says so", () => {
    const { input } = setup();
    const r = applyCrates(
      input([crate("s1", "A", ["Users/x/1.flac"])], { stagedRootGeneration: "stale0000000" }),
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.warnings).toEqual([expect.objectContaining({ code: "root_generation_changed" })]);
  });

  // Serato is checked again right after BEGIN IMMEDIATE, because it could
  // have started after the check the caller made before its backup.
  it("rolls back when Serato is found running inside the transaction", () => {
    const { input, read, masterPath } = setup();
    const m = new DatabaseSync(masterPath);
    m.prepare(
      "INSERT INTO lock (lock_policy, owner_process_id, owner_process_name) VALUES (1, 500, 'Serato DJ Lite')",
    ).run();
    m.close();
    const running: ProcessProbe = { isAlive: (pid) => pid === 500, nameOf: () => "Serato DJ Lite" };
    const r = applyCrates(input([crate("s1", "A", ["Users/x/1.flac"])], { probe: running }));
    expect(isSeratoError(r) && r.error.code).toBe("serato_running");
    expect(revisions(read).sr).toBe(ROOT_BASE_REVISION);
  });

  it("refuses two crates of the same name in one batch", () => {
    const { input, read } = setup();
    const r = applyCrates(
      input([crate("s1", "Same", ["Users/x/1.flac"]), crate("s2", "same", ["Users/x/2.flac"])]),
    );
    expect(isSeratoError(r) && r.error.code).toBe("invalid_crate_name");
    expect(revisions(read).sr).toBe(ROOT_BASE_REVISION);
  });

  // SQLITE_BUSY under busy_timeout becomes busy with a retry hint, never a
  // raw throw. Takes BUSY_TIMEOUT_MS to run, by construction.
  it("reports busy when another writer holds root.sqlite", () => {
    const { input, rootPath, read } = setup();
    const holder = new DatabaseSync(rootPath);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const r = applyCrates(input([crate("s1", "A", ["Users/x/1.flac"])]));
      expect(isSeratoError(r) && r.error.code).toBe("busy");
      if (isSeratoError(r)) expect(r.error.details?.retry_after_ms).toBe(3000);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(revisions(read).sr).toBe(ROOT_BASE_REVISION);
  });

  // Only contention is worth a retry. A file that is not a database fails the
  // same way every time, so it must not come back as busy.
  it("does not call a damaged root.sqlite busy", () => {
    const { input, rootPath } = setup();
    writeFileSync(rootPath, "not a database ".repeat(300));
    const r = applyCrates(input([crate("s1", "A", ["Users/x/1.flac"])]));
    expect(isSeratoError(r) && r.error.code).toBe("write_failed_not_committed");
    if (isSeratoError(r)) expect(r.error.details?.stage).toBe("begin");
  });

  // A reader on another connection holds SHARED, so COMMIT cannot take
  // EXCLUSIVE. That is contention: busy with a retry hint, and nothing written.
  // Takes BUSY_TIMEOUT_MS by construction.
  it("reports busy, and writes nothing, when a reader blocks COMMIT", () => {
    const { input, rootPath, read } = setup();
    const reader = new DatabaseSync(rootPath, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) AS n FROM container").get();
    const r = (() => {
      try {
        return applyCrates(input([crate("s1", "A", ["Users/x/1.flac"])]));
      } finally {
        reader.exec("COMMIT");
        reader.close();
      }
    })();
    expect(isSeratoError(r) && r.error.code).toBe("busy");
    if (isSeratoError(r)) expect(r.error.details?.retry_after_ms).toBe(3000);
    expect(revisions(read).sr).toBe(ROOT_BASE_REVISION);
  });

  // The second Serato check must run while the write lock is held, or
  // Serato could start between the check and BEGIN. Observed from inside
  // the probe: another writer must already be shut out.
  it("checks Serato while already holding root.sqlite's write lock", () => {
    const { input, rootPath, masterPath } = setup();
    const m = new DatabaseSync(masterPath);
    m.prepare(
      "INSERT INTO lock (lock_policy, owner_process_id, owner_process_name) VALUES (1, 500, 'Serato DJ Lite')",
    ).run();
    m.close();
    let lockedDuringCheck: boolean | undefined;
    const observing: ProcessProbe = {
      isAlive: () => {
        const other = new DatabaseSync(rootPath);
        try {
          other.exec("BEGIN IMMEDIATE");
          other.exec("ROLLBACK");
          lockedDuringCheck = false;
        } catch (e) {
          lockedDuringCheck = isSqliteBusy(e);
        } finally {
          other.close();
        }
        return false;
      },
      nameOf: () => null,
    };
    const r = applyCrates(input([crate("s1", "A", ["Users/x/1.flac"])], { probe: observing }));
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(lockedDuringCheck).toBe(true);
  });

  it("refuses, before writing, a space whose revision is already ahead of serato's", () => {
    const { input, rootPath, read } = setup();
    const db = new DatabaseSync(rootPath);
    db.prepare("UPDATE space SET revision = ? WHERE id = ?").run(
      ROOT_BASE_REVISION + 5,
      ROOT_SPACE_ID,
    );
    db.close();
    const r = applyCrates(input([crate("s1", "A", ["Users/x/1.flac"])]));
    expect(isSeratoError(r) && r.error.details?.reason).toBe("space_revision_ahead");
    expect(revisions(read)).toEqual({ sr: ROOT_BASE_REVISION, spr: ROOT_BASE_REVISION + 5 });
  });

  it("refuses a missing root.sqlite without creating one", () => {
    const { input, rootPath } = setup();
    rmSync(rootPath);
    const r = applyCrates(input([crate("s1", "A", ["Users/x/1.flac"])]));
    expect(isSeratoError(r) && r.error.details?.reason).toBe("root_missing");
    expect(existsSync(rootPath)).toBe(false);
  });

  // The pre-COMMIT checks never look at names, so a trigger that renames the
  // row right after its own insert still commits cleanly -- only
  // verifyCommitted, on the new connection after COMMIT, catches it.
  it("fails verification after commit when the crate's name changes post-insert", () => {
    const { input, rootPath } = setup();
    const seed = new DatabaseSync(rootPath);
    seed.exec(
      `CREATE TRIGGER mangle AFTER INSERT ON container WHEN new.name = 'Mangle'
       BEGIN UPDATE container SET name = 'Mangled' WHERE id = new.id; END`,
    );
    seed.close();
    const applyInput = input([crate("s1", "Mangle", ["Users/x/1.flac"])]);
    const r = applyCrates(applyInput);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_failed_committed_unverified");
      expect(r.error.details?.stage).toBe("verify_after_commit");
      expect(r.error.details?.backup_paths).toEqual(applyInput.backupPaths);
      expect(r.error.details?.problems).toEqual(['container 4 does not read back as "Mangle"']);
    }
  });
});

describe("verifyCommitted", () => {
  // A container that does not exist at all: every axis mismatches at once,
  // which is a different shape from the single-axis tests below and still
  // proves the branch that hands the user their backup paths.
  it("reports committed_unverified with the backup paths when the read-back does not match", () => {
    const { input } = setup();
    const r = verifyCommitted(input([]), {
      applied: [{ staged_id: "s1", name: "Ghost", container_id: 9999, track_count: 2 }],
      revision: ROOT_BASE_REVISION + 1,
      warnings: [],
    });
    expect(isSeratoError(r) && r.error.code).toBe("write_failed_committed_unverified");
    if (isSeratoError(r)) {
      expect(r.error.details?.stage).toBe("verify_after_commit");
      expect(r.error.details?.backup_paths).toEqual({
        root: "/b/root.sqlite",
        master: "/b/master.sqlite",
      });
      expect(r.error.details?.problems).toEqual([
        `serato.revision is ${ROOT_BASE_REVISION}, expected ${ROOT_BASE_REVISION + 1}`,
        `space.revision is undefined, expected ${ROOT_BASE_REVISION + 1}`,
        'container 9999 does not read back as "Ghost"',
        "container 9999 reads back 0 tracks",
      ]);
    }
  });

  it("returns null when a real applied write reads back correctly", () => {
    const { input } = setup();
    const applyInput = input([crate("s1", "A", ["Users/x/1.flac"])]);
    const r = applyCrates(applyInput);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(verifyCommitted(applyInput, r)).toBeNull();
  });

  // One axis at a time, called directly, with the exact problems array
  // pinned: a mutation that drops just that one comparison shows up here
  // even while every other axis still agrees.
  it("names both revisions when serato.revision does not match", () => {
    const { input } = setup();
    const applyInput = input([crate("s1", "A", ["Users/x/1.flac"])]);
    const r = applyCrates(applyInput);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    const mismatched = verifyCommitted(applyInput, { ...r, revision: r.revision + 1 });
    expect(isSeratoError(mismatched)).toBe(true);
    if (isSeratoError(mismatched)) {
      expect(mismatched.error.details?.problems).toEqual([
        `serato.revision is ${r.revision}, expected ${r.revision + 1}`,
        `space.revision is ${r.revision}, expected ${r.revision + 1}`,
      ]);
    }
  });

  it("names the track count when it does not match", () => {
    const { input } = setup();
    const applyInput = input([crate("s1", "A", ["Users/x/1.flac"])]);
    const r = applyCrates(applyInput);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    const mismatched = verifyCommitted(applyInput, {
      ...r,
      applied: [{ ...r.applied[0], track_count: 5 }],
    });
    expect(isSeratoError(mismatched)).toBe(true);
    if (isSeratoError(mismatched)) {
      expect(mismatched.error.details?.problems).toEqual([
        `container ${r.applied[0].container_id} reads back 1 tracks`,
      ]);
    }
  });

  it("returns an error, never null, when the root cannot be read back", () => {
    const { input, rootPath } = setup();
    writeFileSync(rootPath, "not a database ".repeat(300));
    const r = verifyCommitted(input([]), {
      applied: [{ staged_id: "s1", name: "A", container_id: 4, track_count: 1 }],
      revision: ROOT_BASE_REVISION + 1,
      warnings: [],
    });
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("write_failed_committed_unverified");
  });
});
