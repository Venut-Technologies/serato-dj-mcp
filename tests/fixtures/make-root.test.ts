import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  makeLibraryFixture,
  makeRootFixture,
  ROOT_ANCHOR_CONTAINER_ID,
  ROOT_BASE_REVISION,
  ROOT_SPACE_ID,
} from "./make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-root-fx-"));

describe("root.sqlite fixture", () => {
  it("has the anchors spec 5.2 resolves, numbered as the live library numbers them", () => {
    const db = new DatabaseSync(makeRootFixture(tmp()), { readOnly: true });
    const space = db
      .prepare("SELECT id FROM space WHERE name = 'Serato Library' COLLATE NOCASE")
      .get() as { id: number };
    const anchor = db
      .prepare(
        "SELECT c.id FROM space s JOIN container c ON s.id = c.space_id WHERE s.id = ? AND c.parent_id = 0",
      )
      .all(space.id) as { id: number }[];
    db.close();
    expect(space.id).toBe(ROOT_SPACE_ID);
    expect(anchor).toEqual([{ id: ROOT_ANCHOR_CONTAINER_ID }]);
  });

  // The whole write protocol depends on this. Measured 2026-09-14 on a copy
  // of the live root.sqlite: the same statements moved serato.revision
  // 72 -> 73 and the space's revision 72 -> 73 by ASSIGNMENT. A fixture whose
  // triggers did not fire would let every write test pass while the real
  // crate stayed invisible to Serato -- spec 5.4 calls that failure silent.
  it("fires the space-revision triggers exactly as the live file does", () => {
    const dir = tmp();
    const rootPath = makeRootFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }],
    });
    const db = new DatabaseSync(rootPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    db.exec("UPDATE serato SET revision = COALESCE(revision, 0) + 1");
    const rev = (db.prepare("SELECT revision FROM serato").get() as { revision: number }).revision;
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO container (revision, parent_id, name, type, list_order, space_id, expanded, portable_id, color)
         VALUES (?, ?, 'Probe', 1, 1, ?, 0, '', NULL)`,
      )
      .run(rev, ROOT_ANCHOR_CONTAINER_ID, ROOT_SPACE_ID);
    const spaceAsset = db.prepare("SELECT id FROM space_asset LIMIT 1").get() as { id: number };
    db.prepare(
      "INSERT INTO container_asset (revision, container_id, space_asset_id, list_order) VALUES (?, ?, ?, 1)",
    ).run(rev, lastInsertRowid, spaceAsset.id);
    const after = db
      .prepare(
        "SELECT (SELECT revision FROM serato) AS sr, (SELECT revision FROM space WHERE id = ?) AS spr",
      )
      .get(ROOT_SPACE_ID);
    const fk = db.prepare("PRAGMA foreign_key_check(container_asset)").all();
    db.exec("COMMIT");
    db.close();

    expect(after).toEqual({ sr: ROOT_BASE_REVISION + 1, spr: ROOT_BASE_REVISION + 1 });
    expect(fk).toEqual([]);
  });

  // Spec 2.5: a container inserted directly under parent_id = 0 does not
  // move the space revision -- the trigger carries AND new.parent_id <> 0.
  it("does not move the revision for a container directly under the synthetic root", () => {
    const db = new DatabaseSync(makeRootFixture(tmp()));
    db.exec("UPDATE serato SET revision = revision + 1");
    db.prepare(
      "INSERT INTO container (revision, parent_id, name, type, list_order, space_id) VALUES (?, 0, 'Top', 1, 9, ?)",
    ).run(ROOT_BASE_REVISION + 1, ROOT_SPACE_ID);
    const spr = db.prepare("SELECT revision FROM space WHERE id = ?").get(ROOT_SPACE_ID);
    db.close();
    expect(spr).toEqual({ revision: ROOT_BASE_REVISION });
  });

  it("builds master and root with the same tracks, joined by portable_id", () => {
    const dir = tmp();
    const { masterPath, rootPath } = makeLibraryFixture(dir, {
      tracks: [
        { externalId: 1, portableId: "Users/x/a.flac", name: "A" },
        { externalId: 2, portableId: "Users/x/b.flac", name: "B" },
      ],
    });
    const master = new DatabaseSync(masterPath, { readOnly: true });
    const root = new DatabaseSync(rootPath, { readOnly: true });
    const m = master.prepare("SELECT portable_id FROM asset ORDER BY portable_id").all();
    const r = root
      .prepare(
        "SELECT a.portable_id FROM asset a JOIN space_asset sa ON sa.asset_id = a.id WHERE sa.space_id = ? ORDER BY a.portable_id",
      )
      .all(ROOT_SPACE_ID);
    master.close();
    root.close();
    expect(r).toEqual(m);
    expect(rootPath).toBe(join(dir, "root.sqlite"));
  });

  it("seeds existing crates under the anchor, with their tracks", () => {
    const db = new DatabaseSync(
      makeRootFixture(tmp(), {
        tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }],
        crates: [{ name: "Gigs 2026", trackPortableIds: ["Users/x/a.flac"] }],
      }),
      { readOnly: true },
    );
    const row = db
      .prepare(
        `SELECT c.name, c.parent_id, count(ca.id) AS n FROM container c
           LEFT JOIN container_asset ca ON ca.container_id = c.id
          WHERE c.type = 1 GROUP BY c.id`,
      )
      .get();
    db.close();
    expect(row).toEqual({ name: "Gigs 2026", parent_id: ROOT_ANCHOR_CONTAINER_ID, n: 1 });
  });
});
