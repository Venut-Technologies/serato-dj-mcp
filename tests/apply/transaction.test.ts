import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rootGeneration } from "../../src/apply/root.js";
import type { ProcessProbe } from "../../src/apply/serato.js";
import { type ApplyInput, applyCrates } from "../../src/apply/transaction.js";
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
    // Spec 5.4: without the space revision moving, the crate lies in the
    // database and never appears in Serato -- a silent failure.
    expect(revisions(read)).toEqual({ sr: ROOT_BASE_REVISION + 1, spr: ROOT_BASE_REVISION + 1 });
  });

  // Decision 3: one transaction, one revision, for the whole batch.
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

  // Decision 3 again: a conflict on ANY crate refuses the whole batch, and
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

  // Spec 5.5's foreign-key check is about THIS write. A library that already
  // carries an orphan row must not refuse every apply forever over damage the
  // write did not cause.
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

  // Decision 2: a changed root_generation is reported, not refused -- Serato
  // writes root.sqlite mid-session (a DBv2 export, measured) without touching
  // anything a crate depends on.
  it("applies despite a changed root_generation and says so", () => {
    const { input } = setup();
    const r = applyCrates(
      input([crate("s1", "A", ["Users/x/1.flac"])], { stagedRootGeneration: "stale0000000" }),
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.warnings).toEqual([expect.objectContaining({ code: "root_generation_changed" })]);
  });

  // Spec 5.1.3: Serato is checked again right after BEGIN IMMEDIATE, because
  // it could have started after the check the caller made before its backup.
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
});
