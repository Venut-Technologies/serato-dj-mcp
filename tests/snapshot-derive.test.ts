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
