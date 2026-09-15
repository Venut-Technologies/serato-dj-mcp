import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backupLibrary, MAX_BACKUPS } from "../../src/apply/backup.js";
import { isSeratoError } from "../../src/errors.js";
import { makeLibraryFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-backup-"));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("backupLibrary", () => {
  it("copies root.sqlite byte for byte and master.sqlite as a consistent, checked copy", async () => {
    const lib = tmp();
    const { rootPath } = makeLibraryFixture(lib, {
      tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }],
    });
    const r = await backupLibrary(lib, tmp(), "lib000000001");
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(sha(r.root)).toBe(sha(rootPath));
    const copy = new DatabaseSync(r.master, { readOnly: true });
    const ok = copy.prepare("PRAGMA integrity_check").get();
    const n = copy.prepare("SELECT count(*) AS n FROM asset").get();
    copy.close();
    expect(ok).toEqual({ integrity_check: "ok" });
    expect(n).toEqual({ n: 1 });
  });

  // Fail-closed (spec 5.1.4): the backup is the only way back, so no backup
  // means no write.
  it("fails closed when root.sqlite cannot be copied", async () => {
    const lib = tmp();
    makeLibraryFixture(lib, { tracks: [] });
    const r = await backupLibrary(join(lib, "does-not-exist"), tmp(), "lib000000001");
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("write_failed_not_committed");
      expect(r.error.details?.stage).toBe("backup");
    }
  });

  it("keeps the newest ten backups of a library and deletes older ones", async () => {
    const lib = tmp();
    makeLibraryFixture(lib, { tracks: [] });
    const state = tmp();
    for (let i = 0; i < MAX_BACKUPS + 3; i += 1) {
      const r = await backupLibrary(
        lib,
        state,
        "lib000000001",
        new Date(Date.UTC(2026, 8, 14, 10, 0, i)),
      );
      if (isSeratoError(r)) throw new Error("unexpected error");
    }
    const kept = readdirSync(join(state, "backups", "lib000000001")).sort();
    expect(kept).toHaveLength(MAX_BACKUPS);
    expect(kept[0]).toBe("20260914-100003-000");
  });

  it("never touches another library's backups during retention", async () => {
    const lib = tmp();
    makeLibraryFixture(lib, { tracks: [] });
    const state = tmp();
    mkdirSync(join(state, "backups", "other0000000", "20000101-000000-000"), { recursive: true });
    for (let i = 0; i < MAX_BACKUPS + 1; i += 1) {
      await backupLibrary(lib, state, "lib000000001", new Date(Date.UTC(2026, 8, 14, 10, 0, i)));
    }
    expect(readdirSync(join(state, "backups", "other0000000"))).toHaveLength(1);
  });
});
