import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { listCrates, resolveCrate } from "../../src/read/crates.js";
import { makeMasterFixture } from "../fixtures/make.js";

function library() {
  const dir = mkdtempSync(join(tmpdir(), "serato-crates-"));
  const path = makeMasterFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "A" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "B" },
      { externalId: 3, portableId: "Users/x/3.flac", name: "C" },
    ],
    crates: [
      { id: 20, name: "Gigs 2026", trackExternalIds: [1, 2] },
      { id: 21, name: "Warmups", trackExternalIds: [] },
    ],
  });
  return new DatabaseSync(path, { readOnly: true });
}

describe("listCrates", () => {
  const db = library();

  it("lists the crates with their space, path and distinct track count", () => {
    expect(listCrates(db, { limit: 10 })).toEqual([
      {
        id: 20,
        name: "Gigs 2026",
        space: "Serato Library",
        path: "Serato Library / Gigs 2026",
        parent_id: 5,
        type: 1,
        track_count: 2,
      },
      {
        id: 21,
        name: "Warmups",
        space: "Serato Library",
        path: "Serato Library / Warmups",
        parent_id: 5,
        type: 1,
        track_count: 0,
      },
    ]);
  });

  // Decision 5: the 15 space roots and the smart crate (whose real name is
  // "Stems<private-use char>22222222...") are noise in the model's context.
  it("shows no space roots", () => {
    expect(listCrates(db, { limit: 100 }).every((c) => c.type === 1)).toBe(true);
  });

  it("pages by id", () => {
    expect(listCrates(db, { limit: 1 }).map((c) => c.id)).toEqual([20]);
    expect(listCrates(db, { limit: 10, afterId: 20 }).map((c) => c.id)).toEqual([21]);
  });
});

describe("resolveCrate", () => {
  const db = library();

  it("finds a crate by id and by name, ignoring case", () => {
    expect(resolveCrate(db, { id: 20 })).toMatchObject({ name: "Gigs 2026" });
    expect(resolveCrate(db, { name: "gigs 2026" })).toMatchObject({ id: 20 });
  });

  // Decision 8: exact match, and the refusal carries the whole list so the
  // model can pick without a second round trip.
  it("refuses a partial name and shows what exists", () => {
    const r = resolveCrate(db, { name: "Gigs" });
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.details?.reason).toBe("unknown_crate");
    expect(r.error.details?.available).toEqual(["Gigs 2026", "Warmups"]);
  });

  it("refuses an unknown id", () => {
    const r = resolveCrate(db, { id: 999 });
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("unknown_crate");
  });

  it("refuses when neither id nor name is given", () => {
    const r = resolveCrate(db, {});
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("crate_ref_missing");
  });
});
