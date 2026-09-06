import { mkdtempSync, writeFileSync } from "node:fs";
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

/** Calls a tool over a real MCP client/server pair and returns its
 *  structuredContent, the same shape a real caller would see. */
async function callToolOverTheWire(
  server: ReturnType<typeof createServer>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as Record<string, unknown>;
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

  // B1: both tools declare outputSchema. The SDK validates structuredContent
  // against it on the success path (validateToolOutput in
  // @modelcontextprotocol/sdk's server/mcp.js) -- if the declared shape did
  // not match what these tools actually return, client.callTool() would
  // reject with McpError(InvalidParams, "Output validation error: ...")
  // instead of resolving. This exercises that over a real client, not just
  // against the schema object directly.
  it("a successful list_libraries call validates against its declared outputSchema", async () => {
    const s = createServer(cli());
    const out = await callToolOverTheWire(s, "list_libraries", {});
    expect(out.active).toEqual(expect.any(String));
    expect(Array.isArray(out.libraries)).toBe(true);
  });

  it("a successful run_sql call validates against its declared outputSchema", async () => {
    const s = createServer(cli({ allowRawSql: true }));
    const out = await callToolOverTheWire(s, "run_sql", { sql: "SELECT 1 AS one" });
    expect(out.columns).toEqual(["one"]);
    expect(out.rows).toEqual([[1]]);
    expect(out.truncated).toBe(false);
    expect(out.generation).toEqual(expect.any(String));
  });

  // The SDK skips outputSchema validation entirely when isError is true
  // (validateToolOutput returns early on `result.isError`), so an error
  // response never has to fit the success shape declared above -- verified
  // here, not just read off the SDK source, because that early return is
  // exactly the assumption B1's outputSchema addition depends on.
  it("an error response is delivered even though it does not match either tool's outputSchema", async () => {
    const s = createServer(cli({ allowRawSql: true }));
    const out = await callToolOverTheWire(s, "run_sql", { sql: "DELETE FROM asset" });
    expect(out.error).toMatchObject({ code: "invalid_argument" });
  });

  // found[0] could be a 3.x directory: joining "master.sqlite" onto it and
  // handing that to runSql() would surface a generic snapshot_failed instead
  // of naming the real problem. A 3.x-only result is not "not found" either
  // (spec 6, 12): it must name the detected version so the user does not
  // retry the same --library and get the same unhelpful answer.
  it("run_sql reports unsupported_version, not library_not_found, when only a 3.x library exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-3x-"));
    writeFileSync(join(dir, "database V2"), "binary");
    const s = createServer(cli({ library: dir, allowRawSql: true }));

    const out = await callToolOverTheWire(s, "run_sql", { sql: "SELECT 1" });
    expect(out.error).toMatchObject({ code: "unsupported_version" });
    const details = (
      out.error as { details?: { detected_version?: string; candidates?: unknown[] } }
    ).details;
    expect(details?.detected_version).toBe("3.x");
    expect(details?.candidates).toEqual([{ path: dir, version: "3.x", status: "ok" }]);
  });

  // A candidate exists (an unreadable master.sqlite) but it is neither a
  // readable 4.x nor a 3.x library, so this still falls back to
  // library_not_found -- and, per B3, that response must carry searched[]
  // (spec 6 makes it mandatory) alongside the existing candidates.
  it("run_sql reports library_not_found with searched[] when the only candidate is unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serato-unreadable-"));
    writeFileSync(join(dir, "master.sqlite"), "not sqlite");
    const s = createServer(cli({ library: dir, allowRawSql: true }));

    const out = await callToolOverTheWire(s, "run_sql", { sql: "SELECT 1" });
    expect(out.error).toMatchObject({ code: "library_not_found" });
    const details = (out.error as { details?: { searched?: string[]; candidates?: unknown[] } })
      .details;
    expect(details?.searched).toEqual([dir]);
    expect(details?.candidates).toEqual([{ path: dir, version: "4.x", status: "unreadable" }]);
  });
});
