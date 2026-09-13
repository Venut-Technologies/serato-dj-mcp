import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { getTracks } from "../../src/tools/get-tracks.js";
import { searchTracks } from "../../src/tools/search-tracks.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-gt-"));

function ctx() {
  const dir = tmp();
  makeMasterFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "A", keyValue: 7 },
      { externalId: 2, portableId: "Users/x/2.flac", name: "B", keyText: "6m" },
    ],
  });
  return { library: dir, roots: [], cacheDir: tmp() };
}

describe("get_tracks", () => {
  it("returns the tracks it found and names the ones it did not", async () => {
    const c = ctx();
    const found = await searchTracks({ sort: "added:asc" }, c);
    if (isSeratoError(found)) throw new Error("unexpected error");
    const ids = found.tracks.map((t) => t.id as number);

    const r = await getTracks({ ids: [...ids, 9999] }, c);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.found.map((t) => t.title)).toEqual(["A", "B"]);
    expect(r.missing).toEqual([9999]);
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);
  });

  // Grounding (spec 3.5): the caller asked in an order, and matching that
  // order is how it lines results up with its own list.
  it("answers in the order the ids were given", async () => {
    const c = ctx();
    const all = await searchTracks({ sort: "added:asc" }, c);
    if (isSeratoError(all)) throw new Error("unexpected error");
    const [first, second] = all.tracks.map((t) => t.id as number);

    const r = await getTracks({ ids: [second, first] }, c);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.found.map((t) => t.title)).toEqual(["B", "A"]);
  });

  it("carries tonality from the derived table, same as search does", async () => {
    const c = ctx();
    const all = await searchTracks({ sort: "added:asc" }, c);
    if (isSeratoError(all)) throw new Error("unexpected error");
    const r = await getTracks({ ids: all.tracks.map((t) => t.id as number) }, c);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.found.map((t) => [t.key, t.key_source])).toEqual([
      ["8A", "key_value"],
      ["1A", "open_key"],
    ]);
  });

  it("refuses an empty list and one over the ceiling", async () => {
    const empty = await getTracks({ ids: [] }, ctx());
    expect(isSeratoError(empty)).toBe(true);
    if (isSeratoError(empty)) expect(empty.error.code).toBe("invalid_argument");

    const tooMany = await getTracks({ ids: Array.from({ length: 201 }, (_, i) => i + 1) }, ctx());
    expect(isSeratoError(tooMany)).toBe(true);
    if (isSeratoError(tooMany)) expect(tooMany.error.code).toBe("invalid_argument");
  });

  it("reports every id as missing when none exist, rather than erroring", async () => {
    const r = await getTracks({ ids: [4242] }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.found).toEqual([]);
    expect(r.missing).toEqual([4242]);
  });
});
