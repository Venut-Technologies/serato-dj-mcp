import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { searchTracks } from "../../src/tools/search-tracks.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-st-"));

function ctx() {
  const dir = tmp();
  makeMasterFixture(dir, {
    tracks: [
      {
        externalId: 1,
        portableId: "Users/x/1.flac",
        name: "Rain",
        artist: "Kerri Chandler",
        genre: "House",
        bpm: 124,
        keyValue: 7,
        timeAdded: 100,
      },
      {
        externalId: 2,
        portableId: "Users/x/2.flac",
        name: "Deep Cut",
        artist: "Someone",
        genre: "Techno (Raw / Deep / Hypnotic)",
        bpm: 138,
        keyText: "6m",
        timeAdded: 200,
      },
      {
        externalId: 3,
        portableId: "Users/x/3.flac",
        name: "Rain Dance",
        artist: "Zoe",
        genre: "House",
        bpm: 126,
        keyValue: 7,
        timeAdded: 300,
      },
      // "Ann Rainford" is what exercises the lowest relevance tier: this track
      // matches "rain" only through its artist, never through its title.
      {
        externalId: 4,
        portableId: "Users/x/4.flac",
        name: "Quiet",
        artist: "Ann Rainford",
        genre: "Ambient",
        bpm: null,
        timeAdded: 400,
      },
    ],
    crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [1] }],
  });
  return { library: dir, roots: [], cacheDir: tmp() };
}

const titles = (r: { tracks: Record<string, unknown>[] }) => r.tracks.map((t) => t.title);

describe("search_tracks", () => {
  it("returns the default nine fields and a generation", async () => {
    const r = await searchTracks({ limit: 1, sort: "added:asc" }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(Object.keys(r.tracks[0])).toEqual([
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
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);
  });

  // The whole point of the derived table, end to end: track 2 has
  // key_value -1 and Open Key text, and it still answers a key filter.
  it("finds a track whose key only our own parse recovered", async () => {
    const r = await searchTracks({ key: { camelot: ["1A"] } }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(titles(r)).toEqual(["Deep Cut"]);
    expect(r.tracks[0].key).toBe("1A");
    expect(r.tracks[0].key_source).toBe("open_key");
  });

  it("runs the leading scenario: house 122-126, in 8A, not in Gigs 2026", async () => {
    const inCrate = await searchTracks(
      { genre: "house", bpm: { min: 122, max: 126 }, key: { camelot: ["8A"] } },
      ctx(),
    );
    if (isSeratoError(inCrate)) throw new Error("unexpected error");
    expect(titles(inCrate).sort()).toEqual(["Rain", "Rain Dance"]);

    // "not in the crate" is expressed by the model as a second call plus a
    // difference; the crate filter itself is the positive form.
    const crateOnly = await searchTracks({ crate: { name: "Gigs 2026" } }, ctx());
    if (isSeratoError(crateOnly)) throw new Error("unexpected error");
    expect(titles(crateOnly)).toEqual(["Rain"]);
  });

  it("resolves the crate by name and refuses an unknown one with the list", async () => {
    const r = await searchTracks({ crate: { name: "Gigs" } }, ctx());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.details?.reason).toBe("unknown_crate");
      expect(r.error.details?.available).toEqual(["Gigs 2026"]);
    }
  });

  it("ranks by relevance when q is given and by added:desc when it is not", async () => {
    // Exact title, then title prefix, then a match that exists only in the
    // artist -- the three ranking tiers, in order.
    const ranked = await searchTracks({ q: "rain" }, ctx());
    if (isSeratoError(ranked)) throw new Error("unexpected error");
    expect(titles(ranked)).toEqual(["Rain", "Rain Dance", "Quiet"]);

    const recent = await searchTracks({ limit: 2 }, ctx());
    if (isSeratoError(recent)) throw new Error("unexpected error");
    expect(titles(recent)).toEqual(["Quiet", "Rain Dance"]);
  });

  it("pages with a cursor and stops without one", async () => {
    const c = ctx();
    const first = await searchTracks({ sort: "added:asc", limit: 2 }, c);
    if (isSeratoError(first)) throw new Error("unexpected error");
    expect(titles(first)).toEqual(["Rain", "Deep Cut"]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await searchTracks(
      { sort: "added:asc", limit: 2, cursor: first.next_cursor },
      c,
    );
    if (isSeratoError(second)) throw new Error("unexpected error");
    expect(titles(second)).toEqual(["Rain Dance", "Quiet"]);
    expect(second.next_cursor).toBeUndefined();
  });

  // Spec 4.3: a cursor belongs to the query that produced it.
  it("refuses a cursor carried over to a different query", async () => {
    const c = ctx();
    const first = await searchTracks({ sort: "added:asc", limit: 2 }, c);
    if (isSeratoError(first)) throw new Error("unexpected error");
    const r = await searchTracks(
      { sort: "added:asc", limit: 2, q: "rain", cursor: first.next_cursor },
      c,
    );
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("cursor_query_mismatch");
  });

  it("refuses crate.id together with crate.name, naming the reason", async () => {
    const r = await searchTracks({ crate: { id: 20, name: "Gigs 2026" } }, ctx());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("crate_ref_conflict");
  });

  it("honours a fields projection and refuses an unknown field", async () => {
    const r = await searchTracks({ fields: ["title", "path"], limit: 1, sort: "added:asc" }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(Object.keys(r.tracks[0])).toEqual(["id", "title", "path"]);
    expect(r.tracks[0].path).toBe("/Users/x/1.flac");

    const bad = await searchTracks({ fields: ["loudness"] }, ctx());
    expect(isSeratoError(bad)).toBe(true);
    if (isSeratoError(bad)) expect(bad.error.details?.reason).toBe("unknown_field");
  });

  it("returns an empty page rather than an error when nothing matches", async () => {
    const r = await searchTracks({ q: "nothing here" }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.tracks).toEqual([]);
    expect(r.next_cursor).toBeUndefined();
  });
});
