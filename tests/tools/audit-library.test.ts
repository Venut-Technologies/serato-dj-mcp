import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { auditLibrary } from "../../src/tools/audit-library.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-audit-"));

/**
 * A library with one deliberate instance of each finding: a track with no
 * BPM, one with no key at all, one whose key only our own parse recovers
 * (Serato wrote -1 and left Open Key text), a stale row, a streaming row,
 * and a pair that duplicates by artist and title.
 */
function ctx() {
  const dir = tmp();
  makeMasterFixture(dir, {
    tracks: [
      {
        externalId: 1,
        portableId: "Users/x/1.flac",
        name: "In A Crate",
        artist: "A",
        bpm: 124,
        keyValue: 7,
      },
      {
        externalId: 2,
        portableId: "Users/x/2.flac",
        name: "No BPM",
        artist: "B",
        bpm: null,
        keyValue: 7,
      },
      { externalId: 3, portableId: "Users/x/3.flac", name: "No Key", artist: "C", bpm: 120 },
      {
        externalId: 4,
        portableId: "Users/x/4.flac",
        name: "Open Key Only",
        artist: "D",
        bpm: 128,
        keyText: "6m",
      },
      {
        externalId: 5,
        portableId: "Users/x/5.flac",
        name: "Stale",
        artist: "E",
        bpm: 130,
        keyValue: 3,
        isStale: 1,
      },
      {
        externalId: 6,
        portableId: "streaming://beatport/9",
        name: "Streamed",
        artist: "F",
        bpm: 125,
        keyValue: 3,
        thirdPartyType: 2,
      },
      {
        externalId: 7,
        portableId: "Users/x/7.flac",
        name: "Twice",
        artist: "G",
        bpm: 126,
        keyValue: 5,
      },
      {
        externalId: 8,
        portableId: "Users/x/7-1.flac",
        name: "Twice",
        artist: "G",
        bpm: 126,
        keyValue: 5,
      },
    ],
    crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [1] }],
  });
  return { library: dir, roots: [], cacheDir: tmp() };
}

const byName = (checks: { name: string; count: number }[]) =>
  Object.fromEntries(checks.map((c) => [c.name, c.count]));

describe("audit_library", () => {
  // Every check runs by default, broken_paths included: only its DISK PASS
  // is opt-in, and its database half is Serato's own missing flag, which
  // costs nothing and is a real finding.
  it("runs every check by default, and carries a generation", async () => {
    const r = await auditLibrary({}, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(byName(r.checks)).toEqual({
      missing_bpm: 1,
      missing_key: 1,
      key_unreadable_by_serato: 1,
      stale: 1,
      not_in_any_crate: 7,
      streaming_only: 1,
      duplicates: 1,
      broken_paths: 0,
    });
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);
  });

  // Setting the flag and naming no check that has a filesystem pass used to
  // do nothing at all, silently. Found by review 2026-09-14.
  it("says so when check_filesystem selects nothing that uses it", async () => {
    const r = await auditLibrary({ checks: ["stale"], check_filesystem: true }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: "filesystem_check_not_selected" }),
    ]);
  });

  it("runs the same check once when it is named twice", async () => {
    const r = await auditLibrary({ checks: ["stale", "stale"] }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.checks).toHaveLength(1);
  });

  // An earlier, simpler criterion -- key_value < 0 -- counts both of these
  // as missing. Only one of them is: the other has a key this
  // server reads and its own search matches, so calling it missing would
  // make the audit contradict the search.
  it("separates no key at all from a key Serato itself cannot read", async () => {
    const r = await auditLibrary({ checks: ["missing_key", "key_unreadable_by_serato"] }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    const missing = r.checks.find((c) => c.name === "missing_key");
    const unreadable = r.checks.find((c) => c.name === "key_unreadable_by_serato");
    expect(missing?.count).toBe(1);
    expect(unreadable?.count).toBe(1);
    expect(missing?.sample_ids).not.toEqual(unreadable?.sample_ids);
  });

  it("reports duplicates as groups, not as a flat list of ids", async () => {
    const r = await auditLibrary({ checks: ["duplicates"] }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    const dup = r.checks[0];
    expect(dup.sample_ids).toBeUndefined();
    expect(dup.sample_groups).toHaveLength(1);
    expect(dup.sample_groups?.[0]).toHaveLength(2);
  });

  it("samples at most ten ids per check", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: Array.from({ length: 25 }, (_, i) => ({
        externalId: i + 1,
        portableId: `Users/x/${i}.flac`,
        name: `T${i}`,
        bpm: null,
      })),
    });
    const r = await auditLibrary(
      { checks: ["missing_bpm"] },
      { library: dir, roots: [], cacheDir: tmp() },
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.checks[0].count).toBe(25);
    expect(r.checks[0].sample_ids).toHaveLength(10);
  });

  it("refuses an unknown check by name, listing what exists", async () => {
    const r = await auditLibrary({ checks: ["missing_bpm", "vibes"] }, ctx());
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.details?.reason).toBe("unknown_check");
    expect(r.error.details?.checks).toEqual(["vibes"]);
    expect(r.error.details?.allowed).toContain("missing_bpm");
  });

  describe("broken_paths", () => {
    it("reads only the database flag until asked to touch the disk", async () => {
      const c = ctx();
      const off = await auditLibrary({ checks: ["broken_paths"] }, c);
      if (isSeratoError(off)) throw new Error("unexpected error");
      // No fixture file exists on disk at all, so a filesystem pass would
      // find every one of them missing -- which is exactly what makes this
      // assertion meaningful: is_missing is 0 for all of them.
      expect(off.checks[0].count).toBe(0);
    });

    it("finds files that are gone once asked", async () => {
      const c = ctx();
      const on = await auditLibrary({ checks: ["broken_paths"], check_filesystem: true }, c);
      if (isSeratoError(on)) throw new Error("unexpected error");
      // Seven non-streaming tracks, none of which exist on disk. The
      // streaming row is skipped: its portable_id is not a path.
      expect(on.checks[0].count).toBe(7);
      expect(on.checks[0].sample_ids).toHaveLength(7);
    });
  });

  // The Prepare panel is a type = 1 container too, so "in a crate" must not
  // count it -- otherwise this number disagrees with list_crates, which
  // excludes it.
  it("does not count the Prepare panel as a crate", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: [
        { externalId: 1, portableId: "Users/x/1.flac", name: "Only In Prepare" },
        { externalId: 2, portableId: "Users/x/2.flac", name: "In A Real Crate" },
      ],
      crates: [{ id: 20, name: "Gigs 2026", trackExternalIds: [2] }],
      prepareTrackExternalIds: [1],
    });
    const r = await auditLibrary(
      { checks: ["not_in_any_crate"] },
      { library: dir, roots: [], cacheDir: tmp() },
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    // The track in Prepare is still "not in any crate"; the one in the real
    // crate is not.
    expect(r.checks[0].count).toBe(1);
  });

  // This audit has two duplicate criteria. The tag criterion finds
  // re-imports; this one catches the same recording filed under different
  // tags, and the golden library yields zero of them, so only a fixture can
  // cover it.
  it("finds duplicates by file size and length, not only by tags", async () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: [
        {
          externalId: 1,
          portableId: "Users/x/1.flac",
          name: "Untitled",
          artist: "A",
          fileSize: 4242,
          lengthMs: 321_000,
        },
        {
          externalId: 2,
          portableId: "Users/x/2.flac",
          name: "Different Name",
          artist: "B",
          fileSize: 4242,
          lengthMs: 321_000,
        },
      ],
    });
    const r = await auditLibrary(
      { checks: ["duplicates"] },
      { library: dir, roots: [], cacheDir: tmp() },
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.checks[0].count).toBe(1);
    expect(r.checks[0].sample_groups?.[0]).toHaveLength(2);
  });

  // The module's headline schema-degradation claim: a check whose columns
  // this schema lacks reports nothing, never a wrong number.
  it("omits a check this schema cannot run, and says why", async () => {
    const dir = tmp();
    const path = makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Users/x/1.flac", name: "A" }],
    });
    const w = new DatabaseSync(path);
    // The index on the column has to go first: SQLite refuses DROP COLUMN
    // while an index references it.
    w.exec("DROP INDEX IF EXISTS asset__stale");
    w.exec("ALTER TABLE asset DROP COLUMN is_stale");
    w.close();

    const r = await auditLibrary(
      { checks: ["stale", "missing_bpm"] },
      { library: dir, roots: [], cacheDir: tmp() },
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.checks.map((c) => c.name)).toEqual(["missing_bpm"]);
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: "check_unavailable",
        details: { check: "stale", columns: ["is_stale"] },
      }),
    ]);
  });

  it("reports nothing rather than zero when no location could be checked", async () => {
    const dir = tmp();
    const volume = join(tmp(), "VolumeThatVanishes");
    makeMasterFixture(dir, {
      tracks: [{ externalId: 1, portableId: "Music/a.flac", name: "A" }],
      connectionUri: `${volume}/_Serato_/Library/location.sqlite`,
    });
    rmSync(volume, { recursive: true, force: true });

    const r = await auditLibrary(
      { checks: ["broken_paths"], check_filesystem: true },
      { library: dir, roots: [], cacheDir: tmp() },
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    // Not counted as broken: an unmounted volume says nothing about whether
    // the file exists, and declaring the whole drive missing is the wrong
    // answer to give a DJ whose drive is simply unplugged.
    // Neither counted as broken nor reported as zero: an unmounted volume
    // says nothing about whether the files exist, and "0 broken paths" is a
    // positive claim. Declaring the whole drive missing would be worse still.
    expect(r.checks).toEqual([]);
    expect(r.warnings ?? []).toHaveLength(2);
    expect((r.warnings ?? []).map((w) => w.code)).toEqual([
      "location_disconnected",
      "check_undetermined",
    ]);
  });
});
