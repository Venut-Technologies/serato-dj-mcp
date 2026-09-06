import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools");

/**
 * Spec 3.1: no file under src/tools/ may import the MCP SDK, so the tool
 * layer stays testable without an MCP client -- the SDK is confined to
 * index.ts and server.ts. This held in P1 only because a reviewer grepped
 * for it by hand; P2 through P4 add nine more tools, so it is enforced here
 * instead of relying on that happening again every time.
 */
describe("tool layer does not import the MCP SDK", () => {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".ts"));

  it("found at least one file to check", () => {
    // Guards against the whole test going vacuously green if TOOLS_DIR were
    // ever misspelled or the directory came up empty.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} does not reference @modelcontextprotocol`, () => {
      const contents = readFileSync(join(TOOLS_DIR, file), "utf8");
      expect(contents).not.toContain("@modelcontextprotocol");
    });
  }
});
