// Separate file: vi.mock("node:fs", ...) is hoisted and applies to every
// import of node:fs in this module, so it must not share a file with tests
// that need the real filesystem for unrelated things.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../../src/stage/store.js";

/**
 * What the mock below records and what it is told to do. The real calls go
 * through, with one exception: fsync of a directory is recorded and not
 * executed, because Windows cannot do it at all -- which is the very reason
 * the code under test has a branch, and would otherwise keep the POSIX
 * branch from being exercised on a Windows host.
 */
const fsLog = vi.hoisted(() => ({
  directoriesOpened: [] as string[],
  directoriesFsynced: 0,
  renames: 0,
  /** Error codes the next renames fail with, one per call, before the real
   *  rename is allowed through. */
  renameFailures: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const directoryFds = new Set<number>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (typeof args[0] === "string" && actual.statSync(args[0]).isDirectory()) {
        directoryFds.add(fd);
        fsLog.directoriesOpened.push(args[0]);
      }
      return fd;
    },
    fsyncSync: (fd: number) => {
      if (directoryFds.has(fd)) {
        fsLog.directoriesFsynced += 1;
        return;
      }
      actual.fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      directoryFds.delete(fd);
      actual.closeSync(fd);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      fsLog.renames += 1;
      const code = fsLog.renameFailures.shift();
      if (code !== undefined) {
        const e = new Error(`${code}: simulated rename failure`) as NodeJS.ErrnoException;
        e.code = code;
        throw e;
      }
      actual.renameSync(...args);
    },
  };
});

const tmp = () => mkdtempSync(join(tmpdir(), "serato-atomic-"));

beforeEach(() => {
  fsLog.directoriesOpened = [];
  fsLog.directoriesFsynced = 0;
  fsLog.renames = 0;
  fsLog.renameFailures = [];
});

describe("writeFileAtomic", () => {
  it("fsyncs the directory after the rename on POSIX", () => {
    const dir = tmp();
    writeFileAtomic(join(dir, "stage.json"), "one", "darwin");
    expect(readFileSync(join(dir, "stage.json"), "utf8")).toBe("one");
    expect(fsLog.directoriesOpened).toEqual([dir]);
    expect(fsLog.directoriesFsynced).toBe(1);
  });

  // Measured 2026-10-12 on Windows 11 with Node 25.6.0: fsyncSync on a
  // directory's descriptor fails with EPERM, so every stage and manifest
  // write was refused. The directory must not even be opened there.
  it("does not open or fsync the directory on Windows, and still writes the file", () => {
    const dir = tmp();
    writeFileAtomic(join(dir, "stage.json"), "one", "win32");
    expect(readFileSync(join(dir, "stage.json"), "utf8")).toBe("one");
    expect(fsLog.directoriesOpened).toEqual([]);
    expect(fsLog.directoriesFsynced).toBe(0);
  });

  // Measured the same day: renameSync onto a file another handle has open
  // fails with EPERM on Windows, and a reader holds it only for an instant.
  it("retries a rename Windows refuses while the destination is open elsewhere", () => {
    const dir = tmp();
    const path = join(dir, "stage.json");
    writeFileSync(path, "old");
    fsLog.renameFailures = ["EPERM", "EBUSY"];
    writeFileAtomic(path, "new", "win32");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(fsLog.renames).toBe(3);
    expect(readdirSync(dir)).toEqual(["stage.json"]);
  });

  it("gives up after a bounded number of attempts, keeping the old file and no temp file", () => {
    const dir = tmp();
    const path = join(dir, "stage.json");
    writeFileSync(path, "old");
    fsLog.renameFailures = Array.from({ length: 50 }, () => "EPERM");
    expect(() => writeFileAtomic(path, "new", "win32")).toThrow(/EPERM/);
    expect(fsLog.renames).toBe(6);
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["stage.json"]);
  });

  // A full disk or a cross-device rename does not get better by waiting.
  it("does not retry a failure that is not about the destination being held", () => {
    const dir = tmp();
    fsLog.renameFailures = ["ENOSPC", "ENOSPC"];
    expect(() => writeFileAtomic(join(dir, "stage.json"), "new", "win32")).toThrow(/ENOSPC/);
    expect(fsLog.renames).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  // rename(2) replaces an open file, so on POSIX a failure is not transient
  // and is reported at once, exactly as before.
  it("does not retry on POSIX", () => {
    const dir = tmp();
    fsLog.renameFailures = ["EPERM", "EPERM"];
    expect(() => writeFileAtomic(join(dir, "stage.json"), "new", "darwin")).toThrow(/EPERM/);
    expect(fsLog.renames).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});
