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
    renameSync: () => {
      throw new Error("simulated rename failure");
    },
  };
});

const tmp = () => mkdtempSync(join(tmpdir(), "serato-snap-rename-"));

describe("snapshot: rename failure", () => {
  // The final rmSync/renameSync pair used to sit outside any try/catch, so a
  // rename failure after a successful backup and a passed integrity_check
  // threw a raw Error out of takeSnapshot instead of returning a SeratoError,
  // breaking the "errors are values" contract in src/errors.ts.
  it("returns snapshot_failed instead of throwing when the final publish rename fails", async () => {
    const dir = tmp();
    const live = makeMasterFixture(dir, { tracks: [] });
    const cache = tmp();

    const r = await takeSnapshot(live, cache);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("snapshot_failed");
  });
});
