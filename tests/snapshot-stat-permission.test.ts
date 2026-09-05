// Separate file: vi.mock("node:fs", ...) is hoisted and applies to every
// import of node:fs in this module, so it must not share a file with tests
// that need the real filesystem for unrelated things.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isSeratoError } from "../src/errors.js";
import { takeSnapshot } from "../src/snapshot/index.js";
import { makeMasterFixture } from "./fixtures/make.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // Only the exact main-db path throws; "...master.sqlite-wal" does not
    // end with "master.sqlite", so stalenessKey's own stat of the -wal
    // sidecar is unaffected.
    statSync: (path: Parameters<typeof actual.statSync>[0]) => {
      if (typeof path === "string" && path.endsWith("master.sqlite")) {
        const e = new Error(
          "EACCES: permission denied, stat 'master.sqlite'",
        ) as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      return actual.statSync(path);
    },
  };
});

const tmp = () => mkdtempSync(join(tmpdir(), "serato-snap-stat-"));

describe("snapshot: stat failures other than ENOENT", () => {
  // existsSync (what this check used before) collapses every stat failure
  // into "missing". On a macOS install with restricted Full Disk Access,
  // statSync on the live database can fail with EACCES while the file is
  // right there, and reporting library_not_found in that case sends the
  // user to fix the wrong thing (--library) instead of Full Disk Access.
  it("returns permission_denied, not library_not_found, when stat fails with something other than ENOENT", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });

    const r = await takeSnapshot(live, tmp());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("permission_denied");
  });
});
