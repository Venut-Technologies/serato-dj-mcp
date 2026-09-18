import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  // A real master.sqlite is WAL, and its newest rows can live only in -wal.
  // The backup must carry them, and must be exactly two files a user can copy
  // back -- no sidecars left over from checking the copy.
  it("backs up a WAL master with rows only in its -wal, and leaves no sidecars beside the copy", async () => {
    const lib = tmp();
    const { masterPath } = makeLibraryFixture(lib, {
      tracks: [{ externalId: 1, portableId: "Users/x/a.flac", name: "A" }],
    });
    const writer = new DatabaseSync(masterPath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer
      .prepare(
        "INSERT INTO asset (location_id, external_id, portable_id, file_name, name, name_norm) SELECT location_id, 2, 'Users/x/b.flac', 'b.flac', 'B', 'b' FROM asset LIMIT 1",
      )
      .run();
    try {
      const r = await backupLibrary(lib, tmp(), "lib000000001");
      if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
      expect(readdirSync(dirname(r.master)).sort()).toEqual(["master.sqlite", "root.sqlite"]);
      const copy = new DatabaseSync(r.master, { readOnly: true });
      const n = copy.prepare("SELECT count(*) AS n FROM asset").get();
      copy.close();
      expect(n).toEqual({ n: 2 });
    } finally {
      writer.close();
    }
  });

  // Fail-closed: the backup is the only way back, so no backup means no
  // write.
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

  // If the system clock has moved back past the 10th-newest stamp, the new
  // directory sorts first lexically. Retention must never delete the backup
  // this very call just took, or a fail-closed write proceeds with none.
  it("never deletes the backup it just took, even when the clock moved backward", async () => {
    const lib = tmp();
    makeLibraryFixture(lib, { tracks: [] });
    const state = tmp();
    const libraryBackups = join(state, "backups", "lib000000001");
    for (let i = 0; i < MAX_BACKUPS; i += 1) {
      const dir = join(libraryBackups, `20260914-1000${String(i).padStart(2, "0")}-000`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "dummy"), "x");
    }
    const r = await backupLibrary(lib, state, "lib000000001", new Date(Date.UTC(2026, 0, 1)));
    if (isSeratoError(r)) throw new Error(`unexpected error: ${r.error.message}`);
    expect(existsSync(r.root) && existsSync(r.master)).toBe(true);
    const kept = readdirSync(libraryBackups).sort();
    expect(kept).toHaveLength(10);
    expect(kept).toContain("20260101-000000-000");
  });
});
