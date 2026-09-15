import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { loadStage, type Stage } from "../../src/stage/store.js";
import { searchTracks } from "../../src/tools/search-tracks.js";
import { stageCrate } from "../../src/tools/stage-crate.js";
import { makeLibraryFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-stage-tool-"));

function library(opts: Parameters<typeof makeLibraryFixture>[1] = {}) {
  const dir = tmp();
  const paths = makeLibraryFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "Rain", artist: "Kerri" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "Storm", artist: "Ann" },
      {
        externalId: 3,
        portableId: "Users/x/3.flac",
        name: "Streamed",
        artist: "S",
        thirdPartyType: 2,
      },
    ],
    ...opts,
  });
  const ctx = { library: dir, roots: [], cacheDir: tmp(), stateDir: tmp() };
  return { dir, ctx, ...paths };
}

async function idsByTitle(ctx: { library: string; roots: string[]; cacheDir: string }) {
  const r = await searchTracks({ fields: ["title"], limit: 50 }, ctx);
  if (isSeratoError(r)) throw new Error("unexpected error");
  return new Map(r.tracks.map((t) => [t.title as string, t.id as number]));
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("stage_crate", () => {
  it("stages the tracks by portable_id and shows what was staged, by name", async () => {
    const { ctx } = library();
    const ids = await idsByTitle(ctx);
    const r = await stageCrate(
      { name: "Gigs 2026", track_ids: [ids.get("Storm"), ids.get("Rain")] },
      ctx,
    );
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);

    // Decision 1: the human-readable list is the check that the right tracks
    // were staged.
    expect(r.tracks.map((t) => t.title)).toEqual(["Storm", "Rain"]);
    expect(r.track_count).toBe(2);
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);

    const stage = loadStage(ctx.stateDir, r.library_id) as Stage;
    expect(stage.crates[0].tracks.map((t) => t.portable_id)).toEqual([
      "Users/x/2.flac",
      "Users/x/1.flac",
    ]);
  });

  it("does not touch root.sqlite -- staging only reads", async () => {
    const { ctx, rootPath } = library();
    const before = sha(rootPath);
    const ids = await idsByTitle(ctx);
    await stageCrate({ name: "Gigs", track_ids: [ids.get("Rain")] }, ctx);
    expect(sha(rootPath)).toBe(before);
  });

  // Spec 3.5: an unknown id is named, never dropped, and refuses the whole call.
  it("refuses the whole crate when an id is unknown, naming it", async () => {
    const { ctx } = library();
    const ids = await idsByTitle(ctx);
    const r = await stageCrate({ name: "Gigs", track_ids: [ids.get("Rain"), 9999] }, ctx);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("unknown_ids");
      expect(r.error.details?.missing_ids).toEqual([9999]);
    }
  });

  // Spec 4.2: a streaming track cannot be written into a crate by this protocol.
  it("refuses the whole crate when a track is streaming, naming it", async () => {
    const { ctx } = library();
    const ids = await idsByTitle(ctx);
    const r = await stageCrate(
      { name: "Gigs", track_ids: [ids.get("Rain"), ids.get("Streamed")] },
      ctx,
    );
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_refused");
      expect(r.error.details?.rejected_track_ids).toEqual([ids.get("Streamed")]);
    }
  });

  // Spec 4.2: a track on another volume belongs to a different location store,
  // not to this root.sqlite.
  it("refuses a track that lives on another location", async () => {
    const { ctx, masterPath } = library();
    const m = new DatabaseSync(masterPath);
    m.prepare("INSERT INTO location (id, path, uuid, revision) VALUES (3, NULL, NULL, 1)").run();
    m.prepare("INSERT INTO connection (location_id, database_uri) VALUES (3, ?)").run(
      "/Volumes/DISK/_Serato_/Library/location.sqlite",
    );
    const { lastInsertRowid } = m
      .prepare(
        "INSERT INTO asset (location_id, external_id, portable_id, file_name, name, name_norm) VALUES (3, 1, 'Music/far.flac', 'far.flac', 'Far', 'far')",
      )
      .run();
    m.close();
    const r = await stageCrate({ name: "Gigs", track_ids: [Number(lastInsertRowid)] }, ctx);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_refused");
      expect(r.error.details?.rejected_track_ids).toEqual([Number(lastInsertRowid)]);
    }
  });

  it("deduplicates repeated ids and says so", async () => {
    const { ctx } = library();
    const ids = await idsByTitle(ctx);
    const rain = ids.get("Rain");
    const r = await stageCrate({ name: "Gigs", track_ids: [rain, rain] }, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.track_count).toBe(1);
    expect(r.warnings).toEqual([expect.objectContaining({ code: "duplicates_removed" })]);
  });

  // Spec 4.2: at staging a name conflict is a warning; at apply it refuses.
  it("stages a name that already exists, with a preview warning", async () => {
    const { ctx } = library({
      tracks: [{ externalId: 1, portableId: "Users/x/1.flac", name: "Rain" }],
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [1] }],
    });
    const ids = await idsByTitle(ctx);
    const r = await stageCrate({ name: "gigs 2026", track_ids: [ids.get("Rain")] }, ctx);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.warnings).toEqual([expect.objectContaining({ code: "crate_name_conflict_preview" })]);
  });

  // Decision 8: a second crate of the same name would fail the whole batch at
  // apply, so it is refused here instead.
  it("refuses a name that is already staged", async () => {
    const { ctx } = library();
    const ids = await idsByTitle(ctx);
    await stageCrate({ name: "Gigs", track_ids: [ids.get("Rain")] }, ctx);
    const r = await stageCrate({ name: "GIGS", track_ids: [ids.get("Storm")] }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("invalid_crate_name");
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("already_staged");
  });

  // Decision 1: a moved generation is a warning, not a refusal.
  it("stages against a moved generation and says so", async () => {
    const { ctx } = library();
    const ids = await idsByTitle(ctx);
    const r = await stageCrate(
      { name: "Gigs", track_ids: [ids.get("Rain")], generation: "000000000000" },
      ctx,
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.warnings).toEqual([expect.objectContaining({ code: "snapshot_advanced" })]);
  });

  it("refuses an invalid crate name before reading anything", async () => {
    const { ctx } = library();
    const r = await stageCrate({ name: "A/B", track_ids: [1] }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("invalid_crate_name");
  });

  it("refuses more than 1000 tracks in one call", async () => {
    const { ctx } = library();
    const r = await stageCrate(
      { name: "Big", track_ids: Array.from({ length: 1001 }, (_, i) => i + 1) },
      ctx,
    );
    expect(isSeratoError(r) && r.error.code).toBe("invalid_argument");
  });
});
