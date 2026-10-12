// Separate file: vi.mock("node:fs", ...) is hoisted and applies to every
// import of node:fs in this module, so it must not share a file with tests
// that need the real filesystem for unrelated things.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isSeratoError } from "../src/errors.js";
import { takeSnapshot } from "../src/snapshot/index.js";
import { makeMasterFixture } from "./fixtures/make.js";

/**
 * Windows refuses to replace or delete a file that someone has open, where
 * POSIX lets both happen. Measured 2026-10-12 on Windows 11 with Node
 * 25.6.0: renameSync onto, and rmSync of, a database another connection has
 * open both fail with EPERM. The mock below produces those two refusals on
 * any host, at the moment a real one would occur.
 */
const held = vi.hoisted(() => ({
  /** The final snapshot name is taken by another publisher, who has it open. */
  finalName: false,
  /** Temp files cannot be deleted. */
  tempFiles: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const eperm = (what: string) => {
    const e = new Error(`EPERM: operation not permitted, ${what}`) as NodeJS.ErrnoException;
    e.code = "EPERM";
    return e;
  };
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (!held.finalName) return actual.renameSync(from, to);
      // The other publisher got there first, with the same content.
      actual.copyFileSync(from, to);
      throw eperm("rename");
    },
    rmSync: (path: string, options?: Parameters<typeof actual.rmSync>[1]) => {
      if (held.tempFiles && basename(path).startsWith(".tmp-")) throw eperm("rm");
      return actual.rmSync(path, options);
    },
  };
});

const tmp = () => mkdtempSync(join(tmpdir(), "serato-snap-held-"));

beforeEach(() => {
  held.finalName = false;
  held.tempFiles = false;
});

describe("snapshot: files held open by someone else", () => {
  // Two server instances share one cache directory by default. When both
  // copy the same generation, the second rename is refused on Windows for
  // as long as the first one's file is being read.
  it("serves the snapshot another publisher put at the final name when its own rename is refused", async () => {
    const live = makeMasterFixture(tmp(), {
      tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }],
    });
    const cache = tmp();
    held.finalName = true;

    const snap = await takeSnapshot(live, cache);
    if (isSeratoError(snap)) throw new Error(`unexpected error: ${snap.error.message}`);
    const db = new DatabaseSync(snap.path, { readOnly: true });
    try {
      expect((db.prepare("SELECT count(*) AS n FROM asset").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
    // Its own temp copy is gone; only the published snapshot is left.
    expect(readdirSync(cache).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  // Errors are values. A temp file that cannot be deleted while reporting a
  // failed copy must not turn that report into a thrown EPERM.
  it("still returns snapshot_failed when the temp file of a failed copy cannot be deleted", async () => {
    const dir = tmp();
    const bogus = join(dir, "master.sqlite");
    writeFileSync(bogus, "this is not sqlite");
    held.tempFiles = true;

    const r = await takeSnapshot(bogus, tmp());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("snapshot_failed");
  });
});
