import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { defaultRoots, detectLibrary, discover } from "../src/discovery/index.js";
import { isSeratoError } from "../src/errors.js";
import { makeMasterFixture } from "./fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-disc-"));

describe("discovery", () => {
  it("recognises a 4.x library by master.sqlite", () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });
    const lib = detectLibrary(dir);
    expect(lib?.version).toBe("4.x");
    expect(lib?.schema).toBe(202);
    expect(lib?.status).toBe("ok");
    expect(lib?.uuid).toMatch(/^[0-9a-f]{12}$/);
  });

  // 3.x keeps a binary "database V2" in ~/Music/_Serato_ and no SQLite at
  // all. It is a different product for an integrator, so it is detected and
  // refused rather than half-supported.
  it("recognises a 3.x library by database V2 and no master.sqlite", () => {
    const dir = tmp();
    writeFileSync(join(dir, "database V2"), "binary");
    const lib = detectLibrary(dir);
    expect(lib?.version).toBe("3.x");
    expect(lib?.schema).toBeNull();
  });

  it("returns null for a directory that is not a library", () => {
    expect(detectLibrary(tmp())).toBeNull();
  });

  it("marks an unreadable master.sqlite as unreadable rather than absent", () => {
    const dir = tmp();
    writeFileSync(join(dir, "master.sqlite"), "not sqlite");
    const lib = detectLibrary(dir);
    expect(lib?.status).toBe("unreadable");
    expect(lib?.version).toBe("4.x");
  });

  // node:sqlite opens lazily: for this exact fixture, `new DatabaseSync`
  // succeeds and the throw comes from the PRAGMA read that follows, so the
  // handle is already open by the time detectLibrary's catch runs. A
  // `finally` (rather than a close() only on the success path) is what
  // closes it there; spying on the prototype method proves it was actually
  // called rather than merely trusting the source.
  it("closes the sqlite handle when reading an unreadable master.sqlite throws", () => {
    const dir = tmp();
    writeFileSync(join(dir, "master.sqlite"), "not sqlite");
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      const lib = detectLibrary(dir);
      expect(lib?.status).toBe("unreadable");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("prefers an explicit --library over the roots", () => {
    const explicit = tmp();
    makeMasterFixture(explicit, { tracks: [] });
    const other = tmp();
    makeMasterFixture(other, { tracks: [] });
    const found = discover({ library: explicit, roots: [other] });
    expect(isSeratoError(found)).toBe(false);
    if (isSeratoError(found)) return;
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(explicit);
  });

  it("reports library_not_found with the list of places it looked", () => {
    const empty = tmp();
    const r = discover({ roots: [empty] });
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("library_not_found");
      expect((r.error.details as { searched: string[] }).searched).toContain(empty);
    }
  });

  it("names the macOS default first", () => {
    // Full-path equality, not a suffix match: a hardcoded string ending in
    // the right suffix would satisfy a regex without ever calling
    // homedir(), so this proves the root is actually derived from it.
    expect(defaultRoots()[0]).toBe(
      join(homedir(), "Library", "Application Support", "Serato", "Library"),
    );
  });
});
