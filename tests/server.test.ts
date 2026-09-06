import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, registeredToolNames } from "../src/server.js";
import { makeMasterFixture } from "./fixtures/make.js";

const cli = (over: Partial<Parameters<typeof createServer>[0]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "serato-srv-"));
  makeMasterFixture(dir, { tracks: [] });
  return {
    library: dir,
    roots: [],
    cacheDir: mkdtempSync(join(tmpdir(), "serato-cache-")),
    stateDir: mkdtempSync(join(tmpdir(), "serato-state-")),
    allowWrites: false,
    allowRawSql: false,
    ...over,
  };
};

/**
 * Connects a real MCP Client to the server over a linked in-memory transport
 * pair and asks it, over the wire, what tools/list actually returns.
 *
 * registeredToolNames() reads our own bookkeeping array (see the WeakMap in
 * src/server.ts), not the SDK's registry -- there is no public one to read.
 * A test that only ever checked registeredToolNames() would pass even if
 * that bookkeeping array quietly drifted from what server.registerTool was
 * actually told to do (e.g. the array push survives a refactor that drops
 * the real registerTool call, or vice versa). Cross-checking against a live
 * client closes that gap: it exercises the real MCP protocol layer, not
 * just a variable our own code maintains.
 */
async function toolNamesOverTheWire(server: ReturnType<typeof createServer>): Promise<string[]> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe("server", () => {
  it("registers only list_libraries by default", () => {
    const s = createServer(cli());
    expect(registeredToolNames(s)).toEqual(["list_libraries"]);
  });

  // Not registering the tool is the most reliable form of "off": a tool that
  // exists and refuses can still be called and still costs context.
  it("registers run_sql only with --allow-raw-sql", () => {
    const s = createServer(cli({ allowRawSql: true }));
    expect(registeredToolNames(s).sort()).toEqual(["list_libraries", "run_sql"]);
  });

  it("registers no write tools in P1 even with --allow-writes", () => {
    const s = createServer(cli({ allowWrites: true }));
    expect(registeredToolNames(s)).toEqual(["list_libraries"]);
  });

  // Guards against registeredToolNames() drifting from what the SDK actually
  // exposes: see toolNamesOverTheWire() above for why this check exists
  // alongside the three above rather than instead of them.
  it("what a real MCP client sees over tools/list matches registeredToolNames", async () => {
    const withoutSql = createServer(cli());
    expect((await toolNamesOverTheWire(withoutSql)).sort()).toEqual(
      registeredToolNames(withoutSql).sort(),
    );

    const withSql = createServer(cli({ allowRawSql: true }));
    expect((await toolNamesOverTheWire(withSql)).sort()).toEqual(
      registeredToolNames(withSql).sort(),
    );
  });
});
