import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { buildFilters, compatibleCamelot } from "../../src/read/filters.js";
import { buildDerived } from "../../src/snapshot/derive.js";
import { makeMasterFixture } from "../fixtures/make.js";

/**
 * A real fixture with the derived key table built into it -- the same shape
 * a published snapshot has. Filters are tested by running them, not by
 * comparing SQL strings: a string comparison passes just as happily when the
 * query is wrong.
 */
function library() {
  const dir = mkdtempSync(join(tmpdir(), "serato-filt-"));
  const path = makeMasterFixture(dir, {
    tracks: [
      {
        externalId: 1,
        portableId: "Users/x/1.flac",
        name: "Rain",
        artist: "Kerri Chandler",
        genre: "House",
        bpm: 124,
        keyValue: 7,
        timeAdded: 1_700_000_000,
        rating: 0.8,
        analysisFlags: 28,
      },
      {
        externalId: 2,
        portableId: "Users/x/2.flac",
        name: "Deep Cut",
        artist: "Someone",
        genre: "Techno (Raw / Deep / Hypnotic)",
        bpm: 138,
        keyText: "6m",
        timeAdded: 1_800_000_000,
        analysisFlags: 24,
      },
      {
        externalId: 3,
        portableId: "Users/x/3.flac",
        name: "No Key",
        artist: "Nobody",
        genre: "House",
        bpm: null,
        timeAdded: 1_750_000_000,
        isMissing: 1,
        thirdPartyType: 2,
        comments: "peak time",
      },
      {
        externalId: 4,
        portableId: "Users/x/4.flac",
        name: "Airhorn",
        artist: "Serato",
        genre: "",
        bpm: 124,
        keyValue: 8,
        timeAdded: 1_700_000_100,
      },
    ],
    crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [1, 4] }],
  });
  const db = new DatabaseSync(path);
  buildDerived(db);
  db.close();
  return new DatabaseSync(path, { readOnly: true });
}

const columns = (db: DatabaseSync) =>
  new Set(
    (db.prepare("PRAGMA table_info('asset')").all() as { name: string }[]).map((r) => r.name),
  );

function names(
  db: DatabaseSync,
  args: Parameters<typeof buildFilters>[0],
  crateId?: number,
): string[] {
  const built = buildFilters(args, columns(db), crateId);
  if (isSeratoError(built)) throw new Error(`unexpected error: ${built.error.message}`);
  const where = built.where.length > 0 ? `WHERE ${built.where.join(" AND ")}` : "";
  return (
    db
      .prepare(
        `SELECT a.name FROM asset a LEFT JOIN mcp_key k ON k.asset_id = a.id ${where} ORDER BY a.external_id`,
      )
      .all(...(built.params as never[])) as { name: string }[]
  ).map((r) => r.name);
}

describe("buildFilters", () => {
  const db = library();

  it("returns everything when nothing is filtered", () => {
    expect(names(db, {})).toEqual(["Rain", "Deep Cut", "No Key", "Airhorn"]);
  });

  // Tokens through AND, each token in any field. On the real library genres
  // look like "Techno (Raw / Deep / Hypnotic)", so a whole-string LIKE
  // would find nothing for "techno deep".
  it("requires every token of q, in any of the searched fields", () => {
    expect(names(db, { q: "techno deep" })).toEqual(["Deep Cut"]);
    expect(names(db, { q: "kerri rain" })).toEqual(["Rain"]);
    expect(names(db, { q: "kerri techno" })).toEqual([]);
  });

  it("matches a substring inside a word, which is why this is not FTS5", () => {
    expect(names(db, { q: "handl" })).toEqual(["Rain"]);
  });

  it("searches comments too", () => {
    expect(names(db, { q: "peak" })).toEqual(["No Key"]);
  });

  // A model can and will send a bare % or _; without escaping, "%" matches
  // the whole library and looks like a working search.
  it("treats LIKE wildcards in q as literal text", () => {
    expect(names(db, { q: "%" })).toEqual([]);
    expect(names(db, { q: "_" })).toEqual([]);
  });

  it("filters by a bpm window", () => {
    expect(names(db, { bpm: { min: 120, max: 130 } })).toEqual(["Rain", "Airhorn"]);
  });

  it("turns around + tolerance into a window and excludes tracks with no bpm", () => {
    expect(names(db, { bpm: { around: 124, tolerance_pct: 2 } })).toEqual(["Rain", "Airhorn"]);
    expect(names(db, { bpm: { around: 138, tolerance_pct: 2 } })).toEqual(["Deep Cut"]);
  });

  it("refuses around together with min or max", () => {
    const r = buildFilters({ bpm: { around: 124, min: 100 } }, columns(db));
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("bpm_around_conflict");
  });

  // This is the case the whole derived table exists for: track 2 has
  // key_value -1 and Open Key text "6m", which is 1A.
  it("filters by camelot, including keys only our own parse recovered", () => {
    expect(names(db, { key: { camelot: ["1A"] } })).toEqual(["Deep Cut"]);
    expect(names(db, { key: { camelot: ["8A"] } })).toEqual(["Rain"]);
  });

  it("expands compatible_with to the four cells of the wheel", () => {
    expect(compatibleCamelot("8A")).toEqual(["8A", "7A", "9A", "8B"]);
    expect(compatibleCamelot("1A")).toEqual(["1A", "12A", "2A", "1B"]);
    expect(compatibleCamelot("12B")).toEqual(["12B", "11B", "1B", "12A"]);
    expect(compatibleCamelot("nonsense")).toBeNull();
    expect(names(db, { key: { compatible_with: "8A" } })).toEqual(["Rain", "Airhorn"]);
  });

  it("refuses camelot and compatible_with together, and a malformed cell", () => {
    const both = buildFilters({ key: { camelot: ["8A"], compatible_with: "8A" } }, columns(db));
    expect(isSeratoError(both)).toBe(true);
    if (isSeratoError(both)) expect(both.error.details?.reason).toBe("key_filter_conflict");

    const bad = buildFilters({ key: { camelot: ["13A"] } }, columns(db));
    expect(isSeratoError(bad)).toBe(true);
    if (isSeratoError(bad)) expect(bad.error.details?.reason).toBe("bad_camelot");
  });

  it("matches genre as a case-insensitive substring", () => {
    expect(names(db, { genre: "techno" })).toEqual(["Deep Cut"]);
    expect(names(db, { genre: "house" })).toEqual(["Rain", "No Key"]);
  });

  it("filters by rating and by date, taking ISO dates", () => {
    expect(names(db, { rating: { min: 0.5 } })).toEqual(["Rain"]);
    expect(names(db, { added: { after: "2026-01-01" } })).toEqual(["Deep Cut"]);
  });

  it("refuses a date it cannot parse", () => {
    const r = buildFilters({ added: { after: "last tuesday" } }, columns(db));
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("bad_date");
  });

  it("filters by crate membership through location_container", () => {
    expect(names(db, {}, 20)).toEqual(["Rain", "Airhorn"]);
  });

  it("filters by the flags", () => {
    expect(names(db, { flags: { analyzed: true } })).toEqual(["Rain", "No Key", "Airhorn"]);
    expect(names(db, { flags: { analyzed: false } })).toEqual(["Deep Cut"]);
    expect(names(db, { flags: { missing: true } })).toEqual(["No Key"]);
    expect(names(db, { flags: { streaming: true } })).toEqual(["No Key"]);
  });

  // A schema without the column must not produce broken SQL, and it must
  // not drop the condition in silence either -- a dropped bpm window turns
  // the whole library into "the tracks at 122-126".
  it("skips a filter whose column this schema does not have, and says so", () => {
    const built = buildFilters({ genre: "house" }, new Set(["id", "name"]));
    if (isSeratoError(built)) throw new Error("unexpected error");
    expect(built.where).toEqual([]);
    expect(built.warnings).toEqual([
      expect.objectContaining({
        code: "filter_unavailable",
        details: { filter: "genre", columns: ["genre"] },
      }),
    ]);
  });

  it("warns for every filter kind this schema cannot express", () => {
    const bare = new Set(["id", "name"]);
    const built = buildFilters(
      {
        bpm: { min: 120 },
        rating: { min: 0.5 },
        added: { after: "2026-01-01" },
        flags: { analyzed: true, missing: true, streaming: true },
      },
      bare,
    );
    if (isSeratoError(built)) throw new Error("unexpected error");
    expect(built.where).toEqual([]);
    expect(built.warnings.map((w) => (w.details as { filter: string }).filter)).toEqual([
      "bpm",
      "rating",
      "added",
      "flags.analyzed",
      "flags.missing",
      "flags.streaming",
    ]);
  });

  // The q branch already chose the safe default -- an unsatisfiable filter
  // rather than everything -- but an empty page still needs explaining.
  it("warns when no column is searchable at all, and matches nothing", () => {
    const built = buildFilters({ q: "rain" }, new Set(["id"]));
    if (isSeratoError(built)) throw new Error("unexpected error");
    expect(built.where).toEqual(["0"]);
    expect(built.warnings).toEqual([
      expect.objectContaining({
        code: "filter_unavailable",
        details: expect.objectContaining({ filter: "q" }),
      }),
    ]);
  });

  // Argument validation does not depend on the schema: the call is wrong
  // either way, and refusing it is more useful than a warning about a
  // condition that was never applicable.
  it("still refuses a contradictory bpm argument when the column is missing", () => {
    const r = buildFilters({ bpm: { around: 124, min: 100 } }, new Set(["id"]));
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("bpm_around_conflict");
  });

  it("still refuses an unparseable date when the column is missing", () => {
    const r = buildFilters({ added: { after: "last tuesday" } }, new Set(["id"]));
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("bad_date");
  });
});
