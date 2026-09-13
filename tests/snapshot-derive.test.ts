import { createHash } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../src/errors.js";
import { DERIVED_VERSION } from "../src/snapshot/derive.js";
import { takeSnapshot } from "../src/snapshot/index.js";
import { makeMasterFixture } from "./fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-derive-"));

describe("derived key table", () => {
  const fixture = () =>
    makeMasterFixture(tmp(), {
      tracks: [
        // Serato parsed this one itself: 21 is D, which is 10B.
        { externalId: 1, portableId: "Users/x/a.flac", name: "A", keyValue: 21, keyText: "D" },
        // The case that covers 75 of 118 real tracks: Serato gave up (-1) and
        // left Open Key text behind. 6m is 1A.
        { externalId: 2, portableId: "Users/x/b.flac", name: "B", keyValue: -1, keyText: "6m" },
        // Neither column has an answer: no row at all, not a row with NULL.
        { externalId: 3, portableId: "Users/x/c.flac", name: "C", keyValue: -1, keyText: "" },
      ],
    });

  it("carries a camelot key for every track that has one, from either column", async () => {
    const snap = await takeSnapshot(fixture(), tmp());
    if (isSeratoError(snap)) throw new Error("unexpected error");

    const db = new DatabaseSync(snap.path, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT a.name, k.camelot, k.number, k.letter, k.source
           FROM asset a LEFT JOIN mcp_key k ON k.asset_id = a.id
          ORDER BY a.external_id`,
      )
      .all() as {
      name: string;
      camelot: string | null;
      number: number | null;
      letter: string | null;
      source: string | null;
    }[];
    db.close();

    expect(rows).toEqual([
      { name: "A", camelot: "10B", number: 10, letter: "B", source: "key_value" },
      { name: "B", camelot: "1A", number: 1, letter: "A", source: "open_key" },
      { name: "C", camelot: null, number: null, letter: null, source: null },
    ]);
  });

  // number and letter are stored apart from camelot so that compatible_with
  // is a plain SQL predicate (number +-1 with wraparound, or the other
  // letter) instead of string surgery in the query.
  it("stores the wheel position in a form a filter can use", async () => {
    const snap = await takeSnapshot(fixture(), tmp());
    if (isSeratoError(snap)) throw new Error("unexpected error");
    const db = new DatabaseSync(snap.path, { readOnly: true });
    const neighbours = db
      .prepare("SELECT camelot FROM mcp_key WHERE number IN (10, 11) AND letter = 'B'")
      .all() as { camelot: string }[];
    db.close();
    expect(neighbours).toEqual([{ camelot: "10B" }]);
  });

  // The derived version travels in the file name: a snapshot published by an
  // older build has no mcp_key at all, and the reuse fast-path would serve it
  // forever without this.
  it("names the snapshot after the derived version", async () => {
    const snap = await takeSnapshot(fixture(), tmp());
    if (isSeratoError(snap)) throw new Error("unexpected error");
    expect(basename(snap.path)).toMatch(new RegExp(`-d${DERIVED_VERSION}\\.sqlite$`));
  });

  // Our writes must be inside the published file, not in a sidecar that the
  // publish step deletes.
  it("leaves no wal sidecar next to the published snapshot", async () => {
    const snap = await takeSnapshot(fixture(), tmp());
    if (isSeratoError(snap)) throw new Error("unexpected error");
    expect(existsSync(`${snap.path}-wal`)).toBe(false);
    expect(existsSync(`${snap.path}-shm`)).toBe(false);
  });
});

/**
 * The derived table is reused across runs by a file name that carries
 * DERIVED_VERSION, so a change to the conversion rules in read/key.ts
 * without a matching bump would keep serving keys computed by the old
 * rules out of a cached snapshot. This digest is what makes that mistake
 * loud: it covers every column of every row, so any change in what
 * tonality() returns moves it.
 *
 * When it fails legitimately -- the rules changed on purpose -- bump
 * DERIVED_VERSION in src/snapshot/derive.ts and update the digest here, in
 * the same commit.
 */
describe("derived key table: golden contents", () => {
  const goldenFixture = () =>
    makeMasterFixture(tmp(), {
      tracks: [
        // One track per source tonality() can report, so the digest moves if
        // any one of the four branches changes.
        { externalId: 1, portableId: "Users/x/1.flac", name: "kv", keyValue: 21 },
        { externalId: 2, portableId: "Users/x/2.flac", name: "open", keyValue: -1, keyText: "6m" },
        { externalId: 3, portableId: "Users/x/3.flac", name: "cam", keyValue: -1, keyText: "9A" },
        { externalId: 4, portableId: "Users/x/4.flac", name: "mus", keyValue: -1, keyText: "Ebm" },
        { externalId: 5, portableId: "Users/x/5.flac", name: "none", keyValue: -1, keyText: "" },
      ],
    });

  it("produces the same table for the same input", async () => {
    const snap = await takeSnapshot(goldenFixture(), tmp());
    if (isSeratoError(snap)) throw new Error("unexpected error");
    const db = new DatabaseSync(snap.path, { readOnly: true });
    const rows = db
      .prepare("SELECT asset_id, camelot, number, letter, source FROM mcp_key ORDER BY asset_id")
      .all();
    db.close();

    expect(rows).toEqual([
      { asset_id: 1, camelot: "10B", number: 10, letter: "B", source: "key_value" },
      { asset_id: 2, camelot: "1A", number: 1, letter: "A", source: "open_key" },
      { asset_id: 3, camelot: "9A", number: 9, letter: "A", source: "camelot" },
      { asset_id: 4, camelot: "2A", number: 2, letter: "A", source: "musical" },
    ]);

    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
    expect({ DERIVED_VERSION, digest }).toEqual({ DERIVED_VERSION: 1, digest: "770be6254b99aa15" });
  });
});

/**
 * With CREATE TABLE IF NOT EXISTS, a source that already carried a table of
 * this name would keep ITS shape, the prepared INSERT would fail on unknown
 * columns, and the throw would come back as snapshot_failed for every read
 * of that library, forever. Owning the table is one line; the failure it
 * prevents is total.
 */
describe("derived key table: a colliding table in the source", () => {
  it("replaces a table of the same name instead of adopting it", async () => {
    const live = makeMasterFixture(tmp(), {
      tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A", keyValue: 21 }],
    });
    const seed = new DatabaseSync(live);
    seed.exec("CREATE TABLE mcp_key (something_else TEXT)");
    seed.prepare("INSERT INTO mcp_key (something_else) VALUES (?)").run("not ours");
    seed.close();

    const snap = await takeSnapshot(live, tmp());
    if (isSeratoError(snap)) throw new Error(`unexpected error: ${snap.error.message}`);

    const db = new DatabaseSync(snap.path, { readOnly: true });
    const rows = db.prepare("SELECT asset_id, camelot, source FROM mcp_key").all();
    db.close();
    expect(rows).toEqual([{ asset_id: 1, camelot: "10B", source: "key_value" }]);
  });
});
