import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  checkRootSchema,
  existingCrateId,
  findAnchors,
  resolveSpaceAssets,
  rootGeneration,
} from "../../src/apply/root.js";
import { isSeratoError } from "../../src/errors.js";
import {
  makeRootFixture,
  ROOT_ANCHOR_CONTAINER_ID,
  ROOT_BASE_REVISION,
  ROOT_SPACE_ID,
} from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-rootq-"));

function rootDb(opts: Parameters<typeof makeRootFixture>[1] = {}) {
  const path = makeRootFixture(tmp(), opts);
  return { path, db: new DatabaseSync(path) };
}

describe("findAnchors", () => {
  it("finds the space by name and its root container by parent_id = 0, not by name", () => {
    const { db } = rootDb();
    expect(findAnchors(db)).toEqual({
      spaceId: ROOT_SPACE_ID,
      rootContainerId: ROOT_ANCHOR_CONTAINER_ID,
    });
    db.close();
  });

  // The root container's name is generated ("<space> root") and a user may
  // create a crate with that very name at another type. Finding the anchor
  // by name would then be ambiguous; by parent_id = 0 it is not.
  it("is not fooled by a crate named like the root container", () => {
    const { db } = rootDb();
    db.prepare(
      "INSERT INTO container (revision, parent_id, name, type, list_order, space_id) VALUES (1, ?, 'Serato Library root', 1, 9, ?)",
    ).run(ROOT_ANCHOR_CONTAINER_ID, ROOT_SPACE_ID);
    expect(findAnchors(db)).toEqual({
      spaceId: ROOT_SPACE_ID,
      rootContainerId: ROOT_ANCHOR_CONTAINER_ID,
    });
    db.close();
  });

  it("refuses when the anchor space is missing", () => {
    const { db } = rootDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("UPDATE space SET name = 'Renamed' WHERE name = 'Serato Library'");
    const r = findAnchors(db);
    expect(isSeratoError(r) && r.error.details?.reason).toBe("anchor_space_missing");
    db.close();
  });

  it("refuses as ambiguous when the space has two root containers", () => {
    const { db } = rootDb();
    db.prepare(
      "INSERT INTO container (revision, parent_id, name, type, list_order, space_id) VALUES (?, ?, ?, 0, ?, ?)",
    ).run(ROOT_BASE_REVISION, 0, "Extra Serato Library root", 99, ROOT_SPACE_ID);
    const r = findAnchors(db);
    expect(isSeratoError(r) && r.error.details?.reason).toBe("anchor_container_ambiguous");
    expect(isSeratoError(r) && r.error.details?.found).toBe(2);
    db.close();
  });

  it("refuses as ambiguous when the space has zero root containers", () => {
    const { db } = rootDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE container SET parent_id = NULL WHERE id = ?").run(ROOT_ANCHOR_CONTAINER_ID);
    const r = findAnchors(db);
    expect(isSeratoError(r) && r.error.details?.reason).toBe("anchor_container_ambiguous");
    expect(isSeratoError(r) && r.error.details?.found).toBe(0);
    db.close();
  });
});

describe("resolveSpaceAssets", () => {
  it("resolves portable_id to space_asset.id, case-insensitively as the index does", () => {
    const { db } = rootDb({ tracks: [{ externalId: 1, portableId: "Users/x/A.flac", name: "A" }] });
    const r = resolveSpaceAssets(db, ROOT_SPACE_ID, ["users/x/a.FLAC", "Users/x/missing.flac"]);
    expect(r.resolved.size).toBe(1);
    expect(r.resolved.get("users/x/a.FLAC")).toEqual(expect.any(Number));
    expect(r.missing).toEqual(["Users/x/missing.flac"]);
    db.close();
  });

  // A track in the database but not in the target space has no space_asset
  // row; this server's write path never creates one (it only ever inserts
  // container and container_asset rows), so it counts as unresolvable.
  it("does not resolve a track that is not in the target space", () => {
    const { db } = rootDb({ tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }] });
    expect(resolveSpaceAssets(db, 1, ["Users/x/a.flac"]).missing).toEqual(["Users/x/a.flac"]);
    db.close();
  });
});

describe("existingCrateId", () => {
  // The UNIQUE constraint is (parent_id, name COLLATE NOCASE, type), so the
  // conflict check has to fold case exactly as it does.
  it("finds a crate of the same name under the anchor, ignoring case", () => {
    const { db } = rootDb({
      tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }],
      crates: [{ name: "Gigs 2026", trackPortableIds: [] }],
    });
    expect(existingCrateId(db, ROOT_ANCHOR_CONTAINER_ID, "gIGS 2026")).toEqual(expect.any(Number));
    expect(existingCrateId(db, ROOT_ANCHOR_CONTAINER_ID, "Gigs 2027")).toBeNull();
    db.close();
  });
});

describe("rootGeneration", () => {
  it("changes when the revision moves and is stable otherwise", () => {
    const { path, db } = rootDb();
    const a = rootGeneration(db, path, "lib");
    expect(rootGeneration(db, path, "lib")).toBe(a);
    db.exec("UPDATE serato SET revision = revision + 1");
    expect(rootGeneration(db, path, "lib")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    db.close();
  });
});

describe("checkRootSchema", () => {
  it("passes on the real schema and refuses when a required table is gone", () => {
    const { db } = rootDb();
    expect(checkRootSchema(db)).toBeNull();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE container_asset");
    const r = checkRootSchema(db);
    expect(isSeratoError(r) && r.error.details?.reason).toBe("root_schema_unsupported");
    db.close();
  });

  // `serato` itself present but missing its `revision` column: every required
  // table exists, so only the column check catches this. Recreating it as a
  // bare table did not need any trigger dropped first -- DROP TABLE takes its
  // own triggers (ON serato) with it; nothing else references the table by
  // name in a way that blocks the drop.
  it("refuses when serato exists but has no revision column", () => {
    const { db } = rootDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE serato");
    db.exec("CREATE TABLE serato (other INTEGER)");
    const r = checkRootSchema(db);
    expect(isSeratoError(r) && r.error.details?.reason).toBe("root_schema_unsupported");
    db.close();
  });
});
