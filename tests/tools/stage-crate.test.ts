import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { acquireWriteLock } from "../../src/apply/mutex.js";
import { resolveLibrary } from "../../src/discovery/index.js";
import { isSeratoError } from "../../src/errors.js";
import * as stageStore from "../../src/stage/store.js";
import { loadStage, type Stage, type StagedCrate, saveStage } from "../../src/stage/store.js";
import { searchTracks } from "../../src/tools/search-tracks.js";
import { MAX_STAGED_CRATES, stageCrate } from "../../src/tools/stage-crate.js";
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

    // The human-readable list is the check that the right tracks were
    // staged, by title rather than by id, so a mismatch is obvious without
    // cross-referencing ids.
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

  // An unknown id is named, never dropped, and refuses the whole call: a
  // crate that is silently missing a track is worse than no crate.
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

  // A streaming track (or one third_party_type marks as remote) has no
  // location on the boot disk, so this protocol refuses it before it ever
  // reaches root.sqlite.
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

  // A track on another volume belongs to a different location store, not to
  // this root.sqlite -- writing it here would point a crate at a track this
  // library's root.sqlite has no location row for.
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
      expect(r.error.details?.reason).toBe("not_on_library_disk");
      expect(r.error.details?.rejected_track_ids).toEqual([Number(lastInsertRowid)]);
    }
  });

  // portable_id itself can say streaming even when a fixture leaves
  // third_party_type at its default of 0 -- isStreamingPortableId is the
  // check that still catches it.
  it("refuses a track whose portable_id is a streaming URL, regardless of third_party_type", async () => {
    const { ctx } = library({
      tracks: [
        {
          externalId: 1,
          portableId: "streaming://service/track/1",
          name: "URLStream",
          artist: "S",
        },
      ],
    });
    const ids = await idsByTitle(ctx);
    const r = await stageCrate({ name: "Gigs", track_ids: [ids.get("URLStream")] }, ctx);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_refused");
      expect(r.error.details?.reason).toBe("streaming");
      expect(r.error.details?.rejected_track_ids).toEqual([ids.get("URLStream")]);
    }
  });

  // No connection row names root.sqlite at all -- an unfamiliar schema,
  // distinct from a track that is genuinely on another disk.
  it("says the library disk is unknown when no connection row names root.sqlite", async () => {
    const { ctx, masterPath } = library();
    const m = new DatabaseSync(masterPath);
    m.prepare("UPDATE connection SET database_uri = ? WHERE location_id = 2").run(
      "/Users/x/Library/Application Support/Serato/Library/location.sqlite",
    );
    m.close();
    const ids = await idsByTitle(ctx);
    const r = await stageCrate({ name: "Gigs", track_ids: [ids.get("Rain")] }, ctx);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_refused");
      expect(r.error.details?.reason).toBe("library_disk_unknown");
    }
  });

  // An unreadable live root.sqlite is its own reason, not the generic
  // snapshot_failed that a thrown error would otherwise surface as (that
  // code names the snapshot copy, not root.sqlite).
  it("refuses when root.sqlite cannot be read, rather than reporting a snapshot failure", async () => {
    const { ctx, rootPath } = library();
    writeFileSync(rootPath, "not a database");
    const ids = await idsByTitle(ctx);
    const r = await stageCrate({ name: "Gigs", track_ids: [ids.get("Rain")] }, ctx);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_refused");
      expect(r.error.details?.reason).toBe("root_unreadable");
    }
  });

  // Two server instances must not be able to stage over each other's crate:
  // a crate already staged before the lock is held must survive a busy
  // attempt untouched.
  it("refuses to stage while another instance holds the write lock, and stages nothing", async () => {
    const { ctx, dir } = library();
    const ids = await idsByTitle(ctx);
    const staged = await stageCrate({ name: "A", track_ids: [ids.get("Rain")] }, ctx);
    if (isSeratoError(staged)) throw new Error(`unexpected error: ${staged.error.message}`);

    const lib = resolveLibrary({ library: dir, roots: [] });
    if (isSeratoError(lib)) throw new Error("unexpected error");
    const held = acquireWriteLock(ctx.stateDir, lib.uuid);
    if (isSeratoError(held)) throw new Error("unexpected error");
    let r: Awaited<ReturnType<typeof stageCrate>>;
    try {
      r = await stageCrate({ name: "B", track_ids: [ids.get("Storm")] }, ctx);
    } finally {
      held.release();
    }
    expect(isSeratoError(r) && r.error.code).toBe("busy");
    const stage = loadStage(ctx.stateDir, lib.uuid) as Stage;
    expect(stage.crates.map((c) => c.name)).toEqual(["A"]);
  });

  // The try/catch that maps a thrown error from reading root.sqlite to
  // busy/root_unreadable must not also wrap the
  // write-lock section. A bug there (simulated by making saveStage throw
  // instead of returning a SeratoError) must propagate to readSession's own
  // handler, not come back mislabelled as a root.sqlite problem.
  it("does not mislabel a bug in the stage section as a root.sqlite problem", async () => {
    const { ctx } = library();
    const ids = await idsByTitle(ctx);
    const spy = vi.spyOn(stageStore, "saveStage").mockImplementation(() => {
      throw new Error("simulated bug");
    });
    try {
      const r = await stageCrate({ name: "Gigs", track_ids: [ids.get("Rain")] }, ctx);
      expect(isSeratoError(r)).toBe(true);
      if (isSeratoError(r)) {
        expect(r.error.code).toBe("snapshot_failed");
        expect(r.error.details?.reason).not.toBe("root_unreadable");
      }
    } finally {
      spy.mockRestore();
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

  // At staging a name conflict is a warning, not a refusal -- only at apply
  // does the same conflict refuse the whole batch.
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

  // A second crate of the same name would fail the whole batch at apply, so
  // it is refused here instead.
  it("refuses a name that is already staged", async () => {
    const { ctx } = library();
    const ids = await idsByTitle(ctx);
    await stageCrate({ name: "Gigs", track_ids: [ids.get("Rain")] }, ctx);
    const r = await stageCrate({ name: "GIGS", track_ids: [ids.get("Storm")] }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("invalid_crate_name");
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("already_staged");
  });

  // A moved generation is a warning, not a refusal: staging must still work
  // while Serato is running and the library keeps changing underneath it.
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

  // C1: root_generation_changed at apply must compare against when the stage
  // was FIRST created, not the last crate appended to it -- otherwise it only
  // ever notices root.sqlite moving since the most recent stage_crate call.
  it("C1: keeps the stage's root_generation from the first crate staged, across later calls", async () => {
    const { ctx, rootPath } = library();
    const ids = await idsByTitle(ctx);
    const a = await stageCrate({ name: "A", track_ids: [ids.get("Rain")] }, ctx);
    if (isSeratoError(a)) throw new Error(`unexpected error: ${a.error.message}`);
    const future = new Date(Date.now() + 60_000);
    utimesSync(rootPath, future, future);
    const b = await stageCrate({ name: "B", track_ids: [ids.get("Storm")] }, ctx);
    if (isSeratoError(b)) throw new Error(`unexpected error: ${b.error.message}`);
    // B's own response still reports the current root_generation.
    expect(b.root_generation).not.toBe(a.root_generation);
    const stage = loadStage(ctx.stateDir, a.library_id) as Stage;
    expect(stage.root_generation).toBe(a.root_generation);
  });

  // C3: the number of staged crates is bounded so the detail preview_changes
  // response is too.
  it("C3: refuses to stage a crate once the cap is reached", async () => {
    const { ctx, dir } = library();
    const ids = await idsByTitle(ctx);
    const rainId = ids.get("Rain") as number;
    const lib = resolveLibrary({ library: dir, roots: [] });
    if (isSeratoError(lib)) throw new Error("unexpected error");
    const crates: StagedCrate[] = Array.from({ length: MAX_STAGED_CRATES }, (_, i) => ({
      staged_id: `s${i}`,
      name: `Crate ${i}`,
      tracks: [{ track_id: rainId, portable_id: "Users/x/1.flac", title: "Rain", artist: "Kerri" }],
      staged_at: "2026-09-14T10:00:00.000Z",
    }));
    const saved = saveStage(ctx.stateDir, {
      schema_version: 1,
      library_id: lib.uuid,
      library_path: lib.path,
      generation: "g",
      root_generation: "r",
      crates,
    });
    if (isSeratoError(saved)) throw new Error("unexpected error");

    const r = await stageCrate({ name: "One More", track_ids: [rainId] }, ctx);
    expect(isSeratoError(r) && r.error.code).toBe("write_refused");
    if (isSeratoError(r)) {
      expect(r.error.details?.reason).toBe("stage_full");
      expect(r.error.details?.rejected_track_ids).toEqual([]);
      expect(r.error.details?.limit).toBe(MAX_STAGED_CRATES);
    }
  });
});
