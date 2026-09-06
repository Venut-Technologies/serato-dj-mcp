import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { listLibraries } from "../../src/tools/list-libraries.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-ll-"));

describe("list_libraries", () => {
  it("reports the library, its schema and its locations", () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });
    const r = listLibraries({}, { library: dir, roots: [] });
    expect(isSeratoError(r)).toBe(false);
    if (isSeratoError(r)) return;

    expect(r.libraries).toHaveLength(1);
    const lib = r.libraries[0];
    expect(lib.version).toBe("4.x");
    expect(lib.schema).toBe(202);
    expect(lib.status).toBe("ok");
    // Exercises locationsOf() actually reading connection.database_uri
    // rather than returning a fixed shape: the fixture seeds exactly one
    // connection row with this uri, so both its count and its contents are
    // pinned to what makeMasterFixture wrote, not to what the code assumes.
    expect(lib.locations).toHaveLength(1);
    expect(lib.locations[0].uri).toBe(
      "/Users/x/Library/Application Support/Serato/Library/root.sqlite",
    );
    expect(lib.locations[0].volumeRoot).toBe("/");
    expect(r.active).toBe(lib.uuid);
    expect(lib.track_count).toBe(0);
  });

  // count(*) FROM asset on the handle already open for introspection, not a
  // hardcoded length -- the fixture's own INSERTs are what this pins to.
  it("counts tracks with a single query on the already-open handle", () => {
    const dir = tmp();
    makeMasterFixture(dir, {
      tracks: [
        { externalId: 1, portableId: "Users/x/a.flac", name: "A" },
        { externalId: 2, portableId: "Users/x/b.flac", name: "B" },
        { externalId: 3, portableId: "Users/x/c.flac", name: "C" },
      ],
    });
    const r = listLibraries({}, { library: dir, roots: [] });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.libraries[0].track_count).toBe(3);
  });

  // 0 would be a claim about the library's contents; a 3.x library has no
  // trustworthy count at all, so it must read null, not 0.
  it("reports track_count as null, not 0, for a 3.x library", () => {
    const dir = tmp();
    writeFileSync(join(dir, "database V2"), "binary");
    const r = listLibraries({}, { library: dir, roots: [] });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.libraries[0].version).toBe("3.x");
    expect(r.libraries[0].track_count).toBeNull();
  });

  it("reports track_count as null for an unreadable master.sqlite", () => {
    const dir = tmp();
    writeFileSync(join(dir, "master.sqlite"), "not sqlite");
    const r = listLibraries({}, { library: dir, roots: [] });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.libraries[0].status).toBe("unreadable");
    expect(r.libraries[0].track_count).toBeNull();
  });

  // list_libraries is the one tool whose path the user must copy verbatim
  // into --library, so it is never redacted. The fixture lives under the
  // real home directory (not the OS temp dir, which sits outside it) so
  // this test would actually fail if redaction were applied.
  it("does not redact the library path", () => {
    const dir = mkdtempSync(join(homedir(), ".serato-ll-redact-"));
    try {
      expect(dir.startsWith(`${homedir()}/`)).toBe(true);
      makeMasterFixture(dir, { tracks: [] });
      const r = listLibraries({}, { library: dir, roots: [] });
      if (isSeratoError(r)) throw new Error("unexpected error");
      expect(r.libraries[0].path).toBe(dir);
      expect(r.libraries[0].path.startsWith("~")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns on an unknown schema version but still reports the library", () => {
    const dir = tmp();
    makeMasterFixture(dir, { userVersion: 999 });
    const r = listLibraries({}, { library: dir, roots: [] });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.libraries[0].schema).toBe(999);
    expect((r as unknown as { warnings: { code: string }[] }).warnings[0].code).toBe(
      "schema_unknown",
    );
  });

  // Asserting only error.code would pass equally if listLibraries synthesised
  // this error itself instead of returning what discover() produced; details.searched
  // is populated by discover() and would not appear in a local synthesis.
  it("passes library_not_found through", () => {
    const dir = tmp();
    const r = listLibraries({}, { library: dir, roots: [] });
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("library_not_found");
      expect(r.error.details?.searched).toContain(dir);
    }
  });

  // A library with status "ok" whose connection table has no rows is a
  // truthful "no locations recorded", not a read failure -- it must not
  // carry the locations_unavailable warning added for the failure case.
  it("reports an empty connection table as no locations, without a warning", () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });
    const db = new DatabaseSync(join(dir, "master.sqlite"));
    db.exec("DELETE FROM connection");
    db.close();

    const r = listLibraries({}, { library: dir, roots: [] });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.libraries[0].status).toBe("ok");
    expect(r.libraries[0].locations).toEqual([]);
    const warnings = (r as unknown as { warnings?: { code: string }[] }).warnings ?? [];
    expect(warnings.some((w) => w.code === "locations_unavailable")).toBe(false);
  });

  // node:sqlite opens lazily: for a master.sqlite that exists but isn't a
  // valid database, `new DatabaseSync` succeeds and the throw comes only
  // from the first statement that reads it, so the handle is already open
  // when locationsOf()'s catch runs. Mirrors
  // tests/discovery.test.ts's "closes the sqlite handle when reading an
  // unreadable master.sqlite throws". Covers the locationsOf() site: with
  // status "unreadable", the schema-introspection block never runs at all
  // (its guard requires status "ok"), so the only handle open() here besides
  // detectLibrary's own (already closed by src/discovery/index.ts) is
  // locationsOf()'s -- this fails at 1 close if its `finally` is removed,
  // and passes at 2 with it.
  it("closes the locations handle when master.sqlite cannot be read there", () => {
    const dir = tmp();
    writeFileSync(join(dir, "master.sqlite"), "not sqlite");
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      const r = listLibraries({}, { library: dir, roots: [] });
      if (isSeratoError(r)) throw new Error("unexpected error");
      expect(r.libraries[0].status).toBe("unreadable");
      expect(r.libraries[0].locations).toEqual([]);
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
