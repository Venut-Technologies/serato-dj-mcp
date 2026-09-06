import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** The two files spec 3.1 allows to import the SDK. */
const SDK_FILES = new Set(["index.ts", "server.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Spec 3.1: the SDK is confined to index.ts and server.ts, so every other
 * layer stays testable without an MCP client. This held in P1 only because a
 * reviewer grepped for it by hand; P2 through P4 add nine more tools and
 * further layers under read/, so it is enforced here instead of relying on
 * that happening again every time.
 *
 * Checks all of src/, not just src/tools/: read/ and schema/ are as much
 * "not the transport" as tools/ is, and a rule that only watches one
 * directory stops being a rule the moment a new one appears.
 */
describe("only the transport layer imports the MCP SDK", () => {
  const files = sourceFiles(SRC_DIR).map((f) => relative(SRC_DIR, f));

  it("found the files to check, including the nested layers", () => {
    // Guards against the whole test going vacuously green if SRC_DIR were
    // misspelled, and against the walk silently not recursing.
    expect(files).toContain("server.ts");
    expect(files.some((f) => f.includes("/"))).toBe(true);
  });

  for (const file of files) {
    const allowed = SDK_FILES.has(file);
    it(`${file} ${allowed ? "may" : "does not"} reference @modelcontextprotocol`, () => {
      const contents = readFileSync(join(SRC_DIR, file), "utf8");
      if (allowed) return;
      expect(contents).not.toContain("@modelcontextprotocol");
    });
  }
});
