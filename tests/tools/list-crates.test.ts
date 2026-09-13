import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { listCratesTool } from "../../src/tools/list-crates.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-lc-"));

function ctx(count = 3) {
  const dir = tmp();
  makeMasterFixture(dir, {
    tracks: [{ externalId: 1, portableId: "Users/x/1.flac", name: "A" }],
    crates: Array.from({ length: count }, (_, i) => ({
      id: 20 + i,
      name: `Crate ${i + 1}`,
      trackExternalIds: i === 0 ? [1] : [],
    })),
  });
  return { library: dir, roots: [], cacheDir: tmp() };
}

describe("list_crates", () => {
  it("returns the crates with a generation", async () => {
    const r = await listCratesTool({}, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.crates.map((c) => c.name)).toEqual(["Crate 1", "Crate 2", "Crate 3"]);
    expect(r.crates[0].track_count).toBe(1);
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);
    expect(r.next_cursor).toBeUndefined();
  });

  it("pages, and the cursor continues the listing", async () => {
    const c = ctx();
    const first = await listCratesTool({ limit: 2 }, c);
    if (isSeratoError(first)) throw new Error("unexpected error");
    expect(first.crates.map((x) => x.name)).toEqual(["Crate 1", "Crate 2"]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await listCratesTool({ cursor: first.next_cursor }, c);
    if (isSeratoError(second)) throw new Error("unexpected error");
    expect(second.crates.map((x) => x.name)).toEqual(["Crate 3"]);
    expect(second.next_cursor).toBeUndefined();
  });

  it("refuses a limit above the ceiling through the shared arg helper", async () => {
    const r = await listCratesTool({ limit: 5000 }, ctx());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("invalid_argument");
      expect(r.error.details?.reason).toBe("schema_violation");
    }
  });
});
