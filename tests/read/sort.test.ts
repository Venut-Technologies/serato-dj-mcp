import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { keysetPredicate, parseSort, sortExpressions } from "../../src/read/sort.js";
import { makeMasterFixture } from "../fixtures/make.js";

function library() {
  const dir = mkdtempSync(join(tmpdir(), "serato-sort-"));
  const path = makeMasterFixture(dir, {
    tracks: [
      {
        externalId: 1,
        portableId: "Users/x/1.flac",
        name: "Rain",
        artist: "Kerri",
        bpm: 124,
        timeAdded: 100,
      },
      {
        externalId: 2,
        portableId: "Users/x/2.flac",
        name: "Rain Dance",
        artist: "Zoe",
        bpm: null,
        timeAdded: 300,
      },
      {
        externalId: 3,
        portableId: "Users/x/3.flac",
        name: "Storm",
        artist: "Ann",
        bpm: 118,
        timeAdded: 200,
      },
      {
        externalId: 4,
        portableId: "Users/x/4.flac",
        name: "After The Rain",
        artist: "Bob",
        bpm: null,
        timeAdded: 400,
      },
    ],
  });
  return new DatabaseSync(path, { readOnly: true });
}

const columns = (db: DatabaseSync) =>
  new Set(
    (db.prepare("PRAGMA table_info('asset')").all() as { name: string }[]).map((r) => r.name),
  );

/** Runs the two-layer query the tools build: inner SELECT computes the sort
 *  key, outer applies the keyset and the ordering. */
function page(
  db: DatabaseSync,
  sort: string | undefined,
  q: string | undefined,
  after?: [number, string | number | null, number],
  limit = 10,
) {
  const spec = parseSort(sort, q !== undefined);
  if (isSeratoError(spec)) throw new Error(`unexpected error: ${spec.error.message}`);
  const e = sortExpressions(spec, columns(db), q);
  const keyset = after === undefined ? { sql: "1", params: [] } : keysetPredicate(spec.dir, after);
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT a.name AS title, ${e.nullExpr} AS _null, ${e.valExpr} AS _val, a.id AS _id
           FROM asset a
       ) WHERE ${keyset.sql} ORDER BY _null ASC, _val ${spec.dir === "asc" ? "ASC" : "DESC"}, _id ASC LIMIT ?`,
    )
    .all(...([...e.params, ...keyset.params, limit] as never[])) as {
    title: string;
    _null: number;
    _val: string | number | null;
    _id: number;
  }[];
  return rows;
}

describe("parseSort", () => {
  it("defaults to relevance when there is a query and to added:desc when there is not", () => {
    expect(parseSort(undefined, true)).toEqual({ field: "relevance", dir: "desc" });
    expect(parseSort(undefined, false)).toEqual({ field: "added", dir: "desc" });
  });

  it("reads the field:direction form", () => {
    expect(parseSort("bpm:asc", false)).toEqual({ field: "bpm", dir: "asc" });
    expect(parseSort("bpm", false)).toEqual({ field: "bpm", dir: "asc" });
    expect(parseSort("added:desc", false)).toEqual({ field: "added", dir: "desc" });
  });

  // Without q there is nothing for relevance to be relative to, and
  // silently sorting by something else would hide that.
  it("refuses relevance without a query", () => {
    const r = parseSort("relevance", false);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("relevance_without_q");
  });

  it("refuses an unknown field and a malformed direction", () => {
    const a = parseSort("loudness:asc", false);
    expect(isSeratoError(a)).toBe(true);
    if (isSeratoError(a)) expect(a.error.details?.reason).toBe("unknown_sort");

    const b = parseSort("bpm:sideways", false);
    expect(isSeratoError(b)).toBe(true);
    if (isSeratoError(b)) expect(b.error.details?.reason).toBe("bad_sort");
  });
});

describe("ordering", () => {
  const db = library();

  it("sorts by bpm with NULLs last, in both directions", () => {
    expect(page(db, "bpm:asc", undefined).map((r) => r.title)).toEqual([
      "Storm",
      "Rain",
      "Rain Dance",
      "After The Rain",
    ]);
    expect(page(db, "bpm:desc", undefined).map((r) => r.title)).toEqual([
      "Rain",
      "Storm",
      "Rain Dance",
      "After The Rain",
    ]);
  });

  it("ranks an exact title above a prefix above a substring above a field match", () => {
    expect(page(db, undefined, "rain").map((r) => r.title)).toEqual([
      "Rain",
      "Rain Dance",
      "After The Rain",
      "Storm",
    ]);
  });

  it("continues exactly where the previous page stopped", () => {
    const first = page(db, "bpm:asc", undefined, undefined, 2);
    expect(first.map((r) => r.title)).toEqual(["Storm", "Rain"]);
    const last = first[first.length - 1];
    const second = page(db, "bpm:asc", undefined, [last._null, last._val, last._id], 2);
    expect(second.map((r) => r.title)).toEqual(["Rain Dance", "After The Rain"]);
  });

  // The NULL block is where a naive keyset silently loops: `val > NULL` is
  // NULL, so without the null flag the second page starts over.
  it("continues correctly from inside the NULL block", () => {
    const all = page(db, "bpm:asc", undefined);
    const third = all[2];
    const rest = page(db, "bpm:asc", undefined, [third._null, third._val, third._id]);
    expect(rest.map((r) => r.title)).toEqual(["After The Rain"]);
  });

  it("walks the whole library in pages of one without repeating or skipping", () => {
    const seen: string[] = [];
    let key: [number, string | number | null, number] | undefined;
    for (let i = 0; i < 10; i++) {
      const rows = page(db, "title:asc", undefined, key, 1);
      if (rows.length === 0) break;
      seen.push(rows[0].title);
      key = [rows[0]._null, rows[0]._val, rows[0]._id];
    }
    expect(seen).toEqual(["After The Rain", "Rain", "Rain Dance", "Storm"]);
  });

  it("falls back and warns when the schema has no column for the sort", () => {
    const spec = parseSort("bpm:asc", false);
    if (isSeratoError(spec)) throw new Error("unexpected error");
    const e = sortExpressions(spec, new Set(["id", "name"]), undefined);
    expect(e.warnings).toEqual([
      expect.objectContaining({ code: "sort_unavailable", details: { field: "bpm" } }),
    ]);
    expect(e.valExpr).toBe("a.id");
  });
});
