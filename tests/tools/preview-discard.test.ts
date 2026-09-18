import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWriteLock } from "../../src/apply/mutex.js";
import { resolveLibrary } from "../../src/discovery/index.js";
import { isSeratoError } from "../../src/errors.js";
import { stagePath } from "../../src/stage/store.js";
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

  // An empty stage is a success with empty arrays, not an error.
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

  // An unknown id is named, never silently ignored.
  it("refuses an unknown staged id, naming it", async () => {
    const { ctx } = await staged(["A"]);
    const r = await discardChanges({ staged_id: "nope0000" }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("unknown_ids");
    if (isSeratoError(r)) expect(r.error.details?.missing_ids).toEqual(["nope0000"]);
  });

  // A concurrent stage_crate/discard_changes must not be able to silently
  // drop this call's write, or vice versa.
  it("refuses to discard while another instance holds the write lock, leaving the stage intact", async () => {
    const { ctx } = await staged(["A"]);
    const lib = resolveLibrary({ library: ctx.library, roots: ctx.roots });
    if (isSeratoError(lib)) throw new Error("unexpected error");
    const held = acquireWriteLock(ctx.stateDir, lib.uuid);
    if (isSeratoError(held)) throw new Error("unexpected error");
    let r: Awaited<ReturnType<typeof discardChanges>>;
    try {
      r = await discardChanges({}, ctx);
    } finally {
      held.release();
    }
    expect(isSeratoError(r) && r.error.code).toBe("busy");
    const left = await previewChanges({}, ctx);
    if (isSeratoError(left)) throw new Error("unexpected error");
    expect(left.pending.map((p) => p.name)).toEqual(["A"]);
  });
});

// A stage file can be well-formed JSON but the wrong shape (a crate or track
// missing required fields). Both tools must refuse it as a value, never
// throw, and never touch the file.
describe("a malformed stage file", () => {
  it("is refused by preview and discard without being thrown or touched", async () => {
    const dir = tmp();
    makeLibraryFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Users/x/1.flac", name: "Rain" }],
    });
    const ctx = { library: dir, roots: [], cacheDir: tmp(), stateDir: tmp() };
    const lib = resolveLibrary({ library: ctx.library, roots: ctx.roots });
    if (isSeratoError(lib)) throw new Error("unexpected error");

    const path = stagePath(ctx.stateDir, lib.uuid);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        library_id: lib.uuid,
        library_path: dir,
        generation: "g",
        root_generation: "r",
        crates: [{}],
      }),
    );
    const before = readFileSync(path, "utf8");

    const p = await previewChanges({}, ctx);
    expect(isSeratoError(p) && p.error.code).toBe("write_refused");
    if (isSeratoError(p)) expect(p.error.details?.reason).toBe("stage_unreadable");
    expect(readFileSync(path, "utf8")).toBe(before);

    const d = await discardChanges({}, ctx);
    expect(isSeratoError(d) && d.error.code).toBe("write_refused");
    if (isSeratoError(d)) expect(d.error.details?.reason).toBe("stage_unreadable");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
