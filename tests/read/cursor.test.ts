import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { checkCursor, encodeCursor, fingerprint, nextCursorFrom } from "../../src/read/cursor.js";

describe("fingerprint", () => {
  it("ignores key order but not values", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it("goes deep, so a nested filter change is visible", () => {
    expect(fingerprint({ bpm: { min: 120 } })).not.toBe(fingerprint({ bpm: { min: 121 } }));
    expect(fingerprint({ bpm: { min: 120, max: 130 } })).toBe(
      fingerprint({ bpm: { max: 130, min: 120 } }),
    );
  });

  it("does not confuse an absent filter with a null one", () => {
    expect(fingerprint({})).not.toBe(fingerprint({ q: null }));
  });
});

describe("checkCursor", () => {
  const key: [number, string | number | null, number] = [0, 124, 7];

  it("round-trips the key", () => {
    const raw = encodeCursor({ fp: "abc", gen: "gen1", key });
    const r = checkCursor(raw, "abc", "gen1");
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.key).toEqual(key);
    expect(r.warnings).toEqual([]);
  });

  it("is opaque base64url, with no padding to break a URL or a shell", () => {
    const raw = encodeCursor({ fp: "abc", gen: "gen1", key });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // Spec 4.3: continuing a different query from an old position would return
  // rows that were never in that query's result.
  it("refuses a cursor whose query changed", () => {
    const raw = encodeCursor({ fp: "abc", gen: "gen1", key });
    const r = checkCursor(raw, "different", "gen1");
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("cursor_query_mismatch");
  });

  // Decision 4 (2026-09-07): a moved generation is a warning, not a refusal.
  // Keyset makes "everything after this key" well defined on the new
  // snapshot; the cost is a few rows skipped or repeated at the seam.
  it("continues on a newer snapshot and says so", () => {
    const raw = encodeCursor({ fp: "abc", gen: "gen1", key });
    const r = checkCursor(raw, "abc", "gen2");
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.key).toEqual(key);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: "snapshot_advanced",
        details: { cursor_generation: "gen1", generation: "gen2" },
      }),
    ]);
  });

  it("refuses text that is not a cursor at all", () => {
    for (const bad of ["", "!!!!", Buffer.from("{}").toString("base64url")]) {
      const r = checkCursor(bad, "abc", "gen1");
      expect(isSeratoError(r)).toBe(true);
      if (isSeratoError(r)) expect(r.error.details?.reason).toBe("cursor_malformed");
    }
  });

  it("gives no next cursor on the last page and one otherwise", () => {
    const row = { _null: 0, _val: 124, _id: 7 };
    expect(nextCursorFrom(false, row, "abc", "gen1")).toBeUndefined();
    expect(nextCursorFrom(true, undefined, "abc", "gen1")).toBeUndefined();
    const raw = nextCursorFrom(true, row, "abc", "gen1");
    if (raw === undefined) throw new Error("expected a cursor");
    const back = checkCursor(raw, "abc", "gen1");
    if (isSeratoError(back)) throw new Error("unexpected error");
    expect(back.key).toEqual([0, 124, 7]);
  });

  it("refuses a cursor whose key is the wrong shape", () => {
    const raw = Buffer.from(JSON.stringify({ fp: "abc", gen: "gen1", key: [0, 1] })).toString(
      "base64url",
    );
    const r = checkCursor(raw, "abc", "gen1");
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("cursor_malformed");
  });
});
