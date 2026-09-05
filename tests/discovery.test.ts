import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    expect(defaultRoots()[0]).toMatch(/Library\/Application Support\/Serato\/Library$/);
  });
});
