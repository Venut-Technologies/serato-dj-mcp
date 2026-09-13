import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { ALL_FIELDS, DEFAULT_FIELDS, mapRow, resolveFields } from "../../src/read/fields.js";

const ALL_COLUMNS = new Set([
  "id",
  "name",
  "artist",
  "album",
  "genre",
  "bpm",
  "rating",
  "length_ms",
  "length_sec",
  "time_added",
  "dj_play_count",
  "is_missing",
  "third_party_type",
  "analysis_flags",
  "portable_id",
  "location_id",
  "comments",
]);

describe("resolveFields", () => {
  it("defaults to the nine fields the spec names, key_source included", () => {
    const r = resolveFields(undefined, ALL_COLUMNS);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.fields).toEqual([
      "id",
      "artist",
      "title",
      "bpm",
      "key",
      "key_source",
      "genre",
      "rating",
      "length",
    ]);
    expect(DEFAULT_FIELDS).toEqual(r.fields);
  });

  // id is the keyset tie-breaker and the handle get_tracks resolves by, so a
  // page without it would be unusable no matter what the caller asked for.
  it("always includes id, even when the caller did not ask for it", () => {
    const r = resolveFields(["title"], ALL_COLUMNS);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.fields).toEqual(["id", "title"]);
  });

  it("refuses an unknown field by name, listing what is allowed", () => {
    const r = resolveFields(["title", "loudness"], ALL_COLUMNS);
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.code).toBe("invalid_argument");
    expect(r.error.details?.reason).toBe("unknown_field");
    expect(r.error.details?.field).toBe("loudness");
    expect(r.error.details?.allowed).toEqual(ALL_FIELDS);
  });

  // Spec 3.3: schema drift is a warning, not a refusal. Serato has 51
  // migrations in its own history.
  it("drops a field whose column is missing and says so in a warning", () => {
    const without = new Set([...ALL_COLUMNS].filter((c) => c !== "bpm"));
    const r = resolveFields(["title", "bpm"], without);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.fields).toEqual(["id", "title"]);
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: "field_unavailable", details: { field: "bpm" } }),
    ]);
  });

  // length_ms leads length_sec: measured 2026-09-03, length_sec was NULL on
  // all 19 demo tracks while length_ms was populated.
  it("prefers length_ms and falls back to length_sec", () => {
    const a = resolveFields(["length"], ALL_COLUMNS);
    if (isSeratoError(a)) throw new Error("unexpected error");
    expect(a.select).toContain('a.length_ms AS "length"');

    const onlySeconds = new Set([...ALL_COLUMNS].filter((c) => c !== "length_ms"));
    const b = resolveFields(["length"], onlySeconds);
    if (isSeratoError(b)) throw new Error("unexpected error");
    expect(b.select).toContain('a.length_sec * 1000 AS "length"');
  });

  it("takes tonality from the derived table, not from asset", () => {
    const r = resolveFields(["key", "key_source"], ALL_COLUMNS);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.select).toContain('k.camelot AS "key"');
    expect(r.select).toContain('k.source AS "key_source"');
  });

  it("selects the extra columns map() needs for path", () => {
    const r = resolveFields(["path"], ALL_COLUMNS);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.select).toContain('a.location_id AS "_location_id"');
  });
});

describe("mapRow", () => {
  const roots = new Map([[2, "/"]]);

  it("returns exactly the requested fields, in order", () => {
    const row = { id: 7, title: "A", bpm: 124 };
    expect(Object.keys(mapRow(row, ["id", "title", "bpm"], roots))).toEqual(["id", "title", "bpm"]);
  });

  it("turns the flag columns into booleans", () => {
    const row = { id: 1, analyzed: 1, missing: 0, streaming: 0 };
    const out = mapRow(row, ["id", "analyzed", "missing", "streaming"], roots);
    expect(out).toEqual({ id: 1, analyzed: true, missing: false, streaming: false });
  });

  it("reports added as an ISO instant, not as a unix integer", () => {
    const out = mapRow({ id: 1, added: 1_700_000_000 }, ["id", "added"], roots);
    expect(out.added).toBe("2023-11-14T22:13:20.000Z");
  });

  // Spec 4.1: redactPath applies to every track path that reaches the model.
  it("builds an absolute path from the volume root and redacts the home prefix", () => {
    const row = { id: 1, path: "Users/x/Music/a.flac", _location_id: 2 };
    expect(mapRow(row, ["id", "path"], roots).path).toBe("/Users/x/Music/a.flac");
  });

  // A streaming portable_id is not a filesystem path and must not be turned
  // into one (spec 2.3).
  it("leaves a streaming id alone", () => {
    const row = { id: 1, path: "streaming://beatport/123", _location_id: 2 };
    expect(mapRow(row, ["id", "path"], roots).path).toBe("streaming://beatport/123");
  });

  it("falls back to the portable_id when the location's root is unknown", () => {
    const row = { id: 1, path: "Users/x/a.flac", _location_id: 99 };
    expect(mapRow(row, ["id", "path"], roots).path).toBe("Users/x/a.flac");
  });

  it("never leaks the underscore-prefixed helper columns", () => {
    const row = { id: 1, path: "Users/x/a.flac", _location_id: 2, _null: 0, _val: 1, _id: 1 };
    expect(Object.keys(mapRow(row, ["id", "path"], roots))).toEqual(["id", "path"]);
  });
});
