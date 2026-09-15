import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { clearStage, loadStage, type Stage, saveStage, stagePath } from "../../src/stage/store.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-stage-"));

const stage = (over: Partial<Stage> = {}): Stage => ({
  schema_version: 1,
  library_id: "abc123def456",
  library_path: "/x/Library",
  generation: "gen1",
  root_generation: "rgen1",
  crates: [
    {
      staged_id: "s1",
      name: "Gigs 2026",
      tracks: [{ track_id: 7, portable_id: "Users/x/a.flac", title: "A", artist: "Z" }],
      staged_at: "2026-09-14T10:00:00.000Z",
    },
  ],
  ...over,
});

describe("stage store", () => {
  it("returns null when nothing has been staged", () => {
    expect(loadStage(tmp(), "abc123def456")).toBeNull();
  });

  it("round-trips a stage", () => {
    const dir = tmp();
    expect(saveStage(dir, stage())).toBe(true);
    expect(loadStage(dir, "abc123def456")).toEqual(stage());
  });

  // One file per library: two libraries' stages must never mix, because the
  // stage stores portable_ids that are only meaningful against one root.sqlite.
  it("keeps each library's stage apart", () => {
    const dir = tmp();
    saveStage(dir, stage());
    saveStage(dir, stage({ library_id: "other0000000", crates: [] }));
    expect((loadStage(dir, "abc123def456") as Stage).crates).toHaveLength(1);
    expect((loadStage(dir, "other0000000") as Stage).crates).toHaveLength(0);
  });

  // Atomic write: a crash mid-write must leave either the old stage or the
  // new one, never a truncated file the next load would refuse.
  it("leaves no temporary files behind", () => {
    const dir = tmp();
    saveStage(dir, stage());
    saveStage(dir, stage({ generation: "gen2" }));
    const files = readdirSync(dirname(stagePath(dir, "abc123def456")));
    expect(files).toEqual(["abc123def456.json"]);
  });

  // A corrupt stage is the user's staged work in an unreadable state. It is
  // refused loudly, never treated as empty -- that would discard it silently.
  it("refuses a stage file it cannot read instead of treating it as empty", () => {
    const dir = tmp();
    saveStage(dir, stage());
    writeFileSync(stagePath(dir, "abc123def456"), "{not json");
    const r = loadStage(dir, "abc123def456");
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_refused");
      expect(r.error.details?.reason).toBe("stage_unreadable");
      expect(r.error.details?.rejected_track_ids).toEqual([]);
    }
  });

  it("refuses a stage written by a different schema version", () => {
    const dir = tmp();
    saveStage(dir, stage());
    writeFileSync(
      stagePath(dir, "abc123def456"),
      JSON.stringify({ ...stage(), schema_version: 99 }),
    );
    const r = loadStage(dir, "abc123def456");
    expect(isSeratoError(r) && r.error.details?.reason).toBe("stage_version");
  });

  it("clears a stage, and clearing a missing one is not an error", () => {
    const dir = tmp();
    saveStage(dir, stage());
    clearStage(dir, "abc123def456");
    expect(existsSync(stagePath(dir, "abc123def456"))).toBe(false);
    expect(() => clearStage(dir, "abc123def456")).not.toThrow();
  });

  it("reports a state directory it cannot create as a value, not a throw", () => {
    const dir = tmp();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const r = saveStage(join(blocker, "state"), stage());
    expect(isSeratoError(r)).toBe(true);
  });
});
