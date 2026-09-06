// Separate file: vi.mock("../../src/schema/index.js", ...) is hoisted and
// applies to every import of that module in this file, so it must not share
// a file with tests that need the real introspect().
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { listLibraries } from "../../src/tools/list-libraries.js";
import { makeMasterFixture } from "../fixtures/make.js";

vi.mock("../../src/schema/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/schema/index.js")>();
  return {
    ...actual,
    introspect: () => {
      throw new Error("simulated introspect failure");
    },
  };
});

const tmp = () => mkdtempSync(join(tmpdir(), "serato-ll-introspect-"));

describe("list_libraries: introspect failure", () => {
  // A well-formed master.sqlite (status "ok") is required so the
  // schema-introspection block's guard actually runs it; introspect() itself
  // is mocked to throw for reasons unrelated to the file (a future schema it
  // cannot parse, say). Covers the introspection-block site specifically:
  // locationsOf() runs too on this fixture and always closes cleanly on its
  // success path regardless of the fix, so the count below moves only with
  // the introspection block's own `finally` -- 2 with it removed, 3 with it
  // in place.
  it("closes the schema handle when introspect() throws", () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      const r = listLibraries({}, { library: dir, roots: [] });
      if (isSeratoError(r)) throw new Error("unexpected error");
      expect(r.libraries[0].status).toBe("ok");
      expect(closeSpy).toHaveBeenCalledTimes(3);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
