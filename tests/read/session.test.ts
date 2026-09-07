import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { readSession, schemaWarnings } from "../../src/read/session.js";
import { takeSnapshot } from "../../src/snapshot/index.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-sess-"));

const ctx = (over: Record<string, unknown> = {}) => {
  const dir = tmp();
  makeMasterFixture(dir, { tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }] });
  return { library: dir, roots: [], cacheDir: tmp(), ...over };
};

describe("readSession", () => {
  it("hands the callback an open snapshot and its schema", async () => {
    const r = await readSession(ctx(), (h) => ({
      tracks: (h.db.prepare("SELECT count(*) AS n FROM asset").get() as { n: number }).n,
      version: h.schema.userVersion,
      generation: h.snapshot.generation,
    }));
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.tracks).toBe(1);
    expect(r.version).toBe(202);
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);
  });

  // The handle must not outlive the session: node:sqlite leaks the file
  // descriptor otherwise, and P1 had that bug three separate times.
  it("closes the database even when the callback throws", async () => {
    let escaped: { prepare: (s: string) => unknown } | undefined;
    const r = await readSession(ctx(), (h) => {
      escaped = h.db;
      throw new Error("boom");
    });
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("snapshot_failed");
    expect(() => escaped?.prepare("SELECT 1")).toThrow();
  });

  it("passes a library failure through untouched", async () => {
    const r = await readSession({ library: "/no/such/dir", roots: [], cacheDir: tmp() }, () => 1);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("library_not_found");
  });

  it("passes an error returned by the callback through as-is", async () => {
    const r = await readSession(ctx(), () => ({
      error: { code: "invalid_argument" as const, message: "no", details: { reason: "test" } },
    }));
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.details?.reason).toBe("test");
  });

  it("resolves the volume root of each location", async () => {
    const r = await readSession(ctx(), (h) => [...h.volumeRoots.entries()]);
    if (isSeratoError(r)) throw new Error("unexpected error");
    // The fixture's connection row points at root.sqlite, whose volume root
    // is "/" (spec 2.3).
    expect(r).toEqual([[2, "/"]]);
  });

  // Spec 3.3: unknown schemas warn and degrade, never refuse. If the
  // connection table is missing or renamed (common in unknown versions),
  // volumeRoots() returns an empty map and the session succeeds.
  it("degrades gracefully when connection table is missing", async () => {
    const libDir = tmp();
    makeMasterFixture(libDir, {
      tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }],
    });
    const cacheDir = tmp();

    // Snapshot the library, then drop the connection table to simulate
    // an unknown schema variant.
    const snapshot = await takeSnapshot(join(libDir, "master.sqlite"), cacheDir);
    if (isSeratoError(snapshot)) throw new Error("unexpected snapshot error");

    const writable = new DatabaseSync(snapshot.path, { readOnly: false });
    writable.exec("DROP TABLE connection");
    writable.close();

    // Session should succeed with empty volumeRoots, not refuse.
    const r = await readSession({ library: libDir, roots: [], cacheDir }, (h) => ({
      volumeRootsEmpty: h.volumeRoots.size === 0,
      canQueryAssets:
        (h.db.prepare("SELECT count(*) AS n FROM asset").get() as { n: number }).n > 0,
    }));
    expect(isSeratoError(r)).toBe(false);
    if (!isSeratoError(r)) {
      expect(r.volumeRootsEmpty).toBe(true);
      expect(r.canQueryAssets).toBe(true);
    }
  });

  // Spec 3.3: an unknown user_version is a warning, never a refusal --
  // Serato has 51 migrations in its own history.
  it("warns about an unknown schema version instead of refusing", async () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [], userVersion: 999 });
    const r = await readSession({ library: dir, roots: [], cacheDir: tmp() }, (h) =>
      schemaWarnings(h),
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r).toEqual([
      expect.objectContaining({
        code: "schema_unknown",
        details: expect.objectContaining({ user_version: 999 }),
      }),
    ]);
  });

  it("says nothing when the schema is known", async () => {
    const r = await readSession(ctx(), (h) => schemaWarnings(h));
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r).toEqual([]);
  });
});
