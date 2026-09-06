// Separate file: vi.mock("node:sqlite", ...) is hoisted and applies to every
// import of node:sqlite in this file, so it must not share a file with tests
// that need the real DatabaseSync for unrelated things.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { listLibraries } from "../../src/tools/list-libraries.js";
import { makeMasterFixture } from "../fixtures/make.js";

vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return {
    ...actual,
    // Subclassing (not replacing) DatabaseSync keeps every other call --
    // detectLibrary()'s PRAGMA user_version, introspect()'s reads -- on the
    // real implementation; only the exact query locationsOf() runs against
    // connection is made to fail, so the master.sqlite itself stays fully
    // readable and status stays "ok".
    DatabaseSync: class extends actual.DatabaseSync {
      prepare(sql: string) {
        if (sql.includes("FROM connection")) {
          throw new Error("simulated connection query failure");
        }
        return super.prepare(sql);
      }
    },
  };
});

const tmp = () => mkdtempSync(join(tmpdir(), "serato-ll-locfail-"));

describe("list_libraries: locations read failure", () => {
  // A well-formed master.sqlite (status "ok", known schema 202) is required
  // so the failure is attributable only to the connection query, not to the
  // library being unreadable -- that's what distinguishes "we couldn't read
  // locations" (this test) from "this library genuinely has none" (the
  // empty-connection-table test in list-libraries.test.ts).
  it("warns with locations_unavailable when the connection table cannot be read", () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [] });

    const r = listLibraries({ library: dir, roots: [] });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.libraries[0].status).toBe("ok");
    expect(r.libraries[0].locations).toEqual([]);

    const warnings = (
      r as unknown as { warnings?: { code: string; details?: Record<string, unknown> }[] }
    ).warnings;
    const warning = warnings?.find((w) => w.code === "locations_unavailable");
    expect(warning).toBeDefined();
    expect(warning?.details?.path).toBe(dir);
    expect(warning?.details?.error).toBe("simulated connection query failure");
  });
});
