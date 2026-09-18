import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What must never reach a published repository, as a test rather than as a
 * habit. It reads the tracked file list from git, so a new file is covered
 * the moment it is added.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((p) => p !== "" && /\.(ts|js|mjs|json|md|sql|yml|yaml)$/.test(p));

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Hits with the file and line, so a failure says where to look. */
function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const path of tracked) {
    const lines = read(path).split("\n");
    for (const [i, line] of lines.entries()) {
      for (const m of line.matchAll(pattern)) found.push(`${path}:${i + 1}: ${m[0]}`);
    }
  }
  return found;
}

// The only two database identifiers a tracked file may carry, in bare hex.
// Both identifier rules below derive their allowed form from this one list.
const SYNTHETIC_IDS = ["11111111111111111111111111111111", "22222222222222222222222222222222"];

describe("repository hygiene", () => {
  it("tracks no file list of its own that git does not know about", () => {
    // Guards the guard: an empty tracked list would make every rule vacuous.
    expect(tracked.length).toBeGreaterThan(30);
  });

  // A SQLite blob literal in a fixture is a database identity. The two the
  // schema needs are synthetic and declared here; anything else is the
  // owner's own library leaking into a public file.
  it("carries no database identifier but the synthetic ones", () => {
    const allowed = new Set(SYNTHETIC_IDS.map((id) => `X'${id}'`));
    const found = hits(/X'[0-9a-fA-F]{16,}'/g).filter(
      (h) => !allowed.has(h.slice(h.indexOf("X'"))),
    );
    expect(found).toEqual([]);
  });

  // The same identifier can leak outside a blob literal too -- a bare hex
  // string handed to Buffer.from(hex), for instance. Kept as its own rule so
  // a failure says which form slipped through.
  it("carries no database identifier as a bare hex run either", () => {
    const allowed = new Set(SYNTHETIC_IDS);
    const found = hits(/\b[0-9a-f]{32}\b/gi).filter(
      (h) => !allowed.has(h.slice(-32).toLowerCase()),
    );
    expect(found).toEqual([]);
  });

  // Paths in examples and fixtures must be invented. These stand-ins are the
  // ones the suite already uses.
  it("names no real user or volume in a path", () => {
    const users = hits(/\/Users\/[A-Za-z0-9._-]+/g).filter(
      (h) => !/\/Users\/(x|v|me)$/.test(h.slice(h.indexOf("/Users/"))),
    );
    const volumes = hits(/\/Volumes\/[A-Za-z0-9._-]+/g).filter(
      (h) => !/\/Volumes\/(DISK|EXTDISK|USB|X)$/.test(h.slice(h.indexOf("/Volumes/"))),
    );
    expect([...users, ...volumes]).toEqual([]);
  });
});
