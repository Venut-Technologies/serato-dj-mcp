import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { discardChanges } from "../../src/tools/discard-changes.js";
import { previewChanges } from "../../src/tools/preview-changes.js";
import { searchTracks } from "../../src/tools/search-tracks.js";
import { stageCrate } from "../../src/tools/stage-crate.js";
import { makeLibraryFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-preview-"));

async function staged(names: string[]) {
  const dir = tmp();
  makeLibraryFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "Rain", artist: "Kerri" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "Storm", artist: "Ann" },
    ],
  });
  const ctx = { library: dir, roots: [], cacheDir: tmp(), stateDir: tmp() };
  const found = await searchTracks({ fields: ["title"] }, ctx);
  if (isSeratoError(found)) throw new Error("unexpected error");
  const ids = found.tracks.map((t) => t.id as number);
  const stagedIds: string[] = [];
  for (const name of names) {
    const r = await stageCrate({ name, track_ids: ids }, ctx);
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    stagedIds.push(r.staged_id);
  }
  return { ctx, stagedIds };
}

describe("preview_changes", () => {
  it("summarises what is staged", async () => {
    const { ctx } = await staged(["A", "B"]);
    const r = await previewChanges({}, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.pending.map((p) => [p.name, p.track_count])).toEqual([
      ["A", 2],
      ["B", 2],
    ]);
    expect(r.pending[0].tracks).toBeUndefined();
    expect(r.summary).toBe("2 crates, 4 tracks");
  });

  it("lists every track by title and artist in detail format", async () => {
    const { ctx } = await staged(["A"]);
    const r = await previewChanges({ format: "detail" }, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.pending[0].tracks?.map((t) => t.title).sort()).toEqual(["Rain", "Storm"]);
  });

  // Spec 4.2: an empty stage is a success with empty arrays, not an error.
  it("reports an empty stage as success", async () => {
    const { ctx } = await staged([]);
    const r = await previewChanges({}, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.pending).toEqual([]);
    expect(r.staged_at).toBeNull();
  });
});

describe("discard_changes", () => {
  it("discards one staged crate by id and keeps the rest", async () => {
    const { ctx, stagedIds } = await staged(["A", "B"]);
    const r = await discardChanges({ staged_id: stagedIds[0] }, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.discarded_ids).toEqual([stagedIds[0]]);
    const left = await previewChanges({}, ctx);
    if (isSeratoError(left)) throw new Error("unexpected error");
    expect(left.pending.map((p) => p.name)).toEqual(["B"]);
  });

  it("discards everything when no id is given", async () => {
    const { ctx, stagedIds } = await staged(["A", "B"]);
    const r = await discardChanges({}, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.discarded_ids).toEqual(stagedIds);
  });

  // Spec 3.5: an unknown id is named, never silently ignored.
  it("refuses an unknown staged id, naming it", async () => {
    const { ctx } = await staged(["A"]);
    const r = await discardChanges({ staged_id: "nope0000" }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("unknown_ids");
    if (isSeratoError(r)) expect(r.error.details?.missing_ids).toEqual(["nope0000"]);
  });
});
