import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { getCrateTracks } from "../../src/tools/get-crate-tracks.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-gct-"));

function ctx() {
  const dir = tmp();
  makeMasterFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "First" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "Second" },
      { externalId: 3, portableId: "Users/x/3.flac", name: "Third" },
      { externalId: 4, portableId: "Users/x/4.flac", name: "Not in the crate" },
    ],
    // Seeded in this order on purpose: the crate's own order is 3, 1, 2 and
    // must survive, because it is the DJ's running order.
    crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [3, 1, 2] }],
  });
  return { library: dir, roots: [], cacheDir: tmp() };
}

describe("get_crate_tracks", () => {
  it("returns the crate and its tracks in the crate's own order", async () => {
    const r = await getCrateTracks({ crate_name: "Gigs 2026" }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.crate).toMatchObject({ id: 20, name: "Gigs 2026", track_count: 3 });
    expect(r.tracks.map((t) => t.title)).toEqual(["Third", "First", "Second"]);
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);
  });

  it("takes the crate by id as well", async () => {
    const r = await getCrateTracks({ crate_id: 20 }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.tracks).toHaveLength(3);
  });

  it("refuses both references at once and neither", async () => {
    const both = await getCrateTracks({ crate_id: 20, crate_name: "Gigs 2026" }, ctx());
    expect(isSeratoError(both)).toBe(true);
    if (isSeratoError(both)) expect(both.error.details?.reason).toBe("crate_ref_conflict");

    const neither = await getCrateTracks({}, ctx());
    expect(isSeratoError(neither)).toBe(true);
    if (isSeratoError(neither)) expect(neither.error.details?.reason).toBe("crate_ref_missing");
  });

  it("pages through the crate without repeating a track", async () => {
    const c = ctx();
    const first = await getCrateTracks({ crate_id: 20, limit: 2 }, c);
    if (isSeratoError(first)) throw new Error("unexpected error");
    expect(first.tracks.map((t) => t.title)).toEqual(["Third", "First"]);

    const second = await getCrateTracks({ crate_id: 20, limit: 2, cursor: first.next_cursor }, c);
    if (isSeratoError(second)) throw new Error("unexpected error");
    expect(second.tracks.map((t) => t.title)).toEqual(["Second"]);
    expect(second.next_cursor).toBeUndefined();
  });

  it("returns an empty track list for an empty crate, not an error", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: [],
      crates: [{ id: 21, name: "Empty", trackExternalIds: [] }],
    });
    const r = await getCrateTracks({ crate_id: 21 }, { library: dir, roots: [], cacheDir: tmp() });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.tracks).toEqual([]);
    expect(r.crate.track_count).toBe(0);
  });
});
