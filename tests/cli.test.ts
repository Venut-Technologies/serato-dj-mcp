import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import { isSeratoError } from "../src/errors.js";

const P = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseArgs(argv, env);

describe("parseArgs", () => {
  it("defaults to read-only with no flags", () => {
    const c = P([]);
    if (isSeratoError(c) || "help" in c || "version" in c) throw new Error("unexpected");
    expect(c.allowWrites).toBe(false);
    expect(c.allowRawSql).toBe(false);
    expect(c.roots).toEqual([]);
    expect(c.cacheDir).toContain("serato-dj-mcp");
    expect(c.stateDir).toContain("serato-dj-mcp");
    expect(c.cacheDir).not.toBe(c.stateDir);
  });

  it("accepts repeated --root and a single --library", () => {
    const c = P(["--root", "/a", "--root", "/b", "--library", "/lib"]);
    if (isSeratoError(c) || "help" in c || "version" in c) throw new Error("unexpected");
    expect(c.roots).toEqual(["/a", "/b"]);
    expect(c.library).toBe("/lib");
  });

  it("lets --library win over SERATO_LIBRARY_PATH", () => {
    const c = P(["--library", "/flag"], { SERATO_LIBRARY_PATH: "/env" });
    if (isSeratoError(c) || "help" in c || "version" in c) throw new Error("unexpected");
    expect(c.library).toBe("/flag");
  });

  it("falls back to SERATO_LIBRARY_PATH", () => {
    const c = P([], { SERATO_LIBRARY_PATH: "/env" });
    if (isSeratoError(c) || "help" in c || "version" in c) throw new Error("unexpected");
    expect(c.library).toBe("/env");
  });

  it("turns on the gated tools only when asked", () => {
    const c = P(["--allow-writes", "--allow-raw-sql"]);
    if (isSeratoError(c) || "help" in c || "version" in c) throw new Error("unexpected");
    expect(c.allowWrites).toBe(true);
    expect(c.allowRawSql).toBe(true);
  });

  // engine-dj-mcp silently ignores unknown flags, so a typo of
  // --allow-writes yields a read-only server with no diagnostic at all.
  it("rejects an unknown flag instead of ignoring it", () => {
    const r = P(["--allow-write"]);
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) {
      expect(r.error.code).toBe("invalid_argument");
      expect(r.error.message).toContain("--allow-write");
    }
  });

  it("rejects a flag that needs a value and has none", () => {
    const r = P(["--library"]);
    expect(isSeratoError(r)).toBe(true);
  });

  it("recognises --help and --version", () => {
    expect(P(["--help"])).toEqual({ help: true });
    expect(P(["--version"])).toEqual({ version: true });
  });
});
