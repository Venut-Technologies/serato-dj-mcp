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

/**
 * Calls a tool over a real MCP client/server pair and returns its logical
 * payload -- structuredContent on success; on error there is no
 * structuredContent (see toCallToolResult in ../src/envelope.ts), so the
 * error object is parsed back out of the JSON text in content[0] instead.
 *
 * Does NOT call listTools() first, so it never builds the client's
 * structuredContent validator -- see callToolAfterListingOverTheWire() below
 * for the ordering that actually exercises it.
 */
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
    if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "{}";
    return JSON.parse(text);
  } finally {
    await client.close();
  }
}

/**
 * Calls a tool the way a real client does: tools/list first, then the call.
 * client.listTools() runs cacheToolMetadata(), which is what builds the
 * structuredContent validator in the first place -- a helper that skips
 * this step (callToolOverTheWire() above) cannot exercise that validator at
 * all, which is exactly the ordering dependence that let the original
 * outputSchema-vs-error-response bug through review undetected.
 */
async function callToolAfterListingOverTheWire(
  server: ReturnType<typeof createServer>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.listTools();
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

describe("server", () => {
  it("registers only the read tools by default", () => {
    const s = createServer(cli());
    expect(registeredToolNames(s).sort()).toEqual([
      "audit_library",
      "get_crate_tracks",
      "get_tracks",
      "list_crates",
      "list_libraries",
      "search_tracks",
    ]);
  });

  // Not registering the tool is the most reliable form of "off": a tool that
  // exists and refuses can still be called and still costs context.
  it("registers run_sql only with --allow-raw-sql", () => {
    const s = createServer(cli({ allowRawSql: true }));
    expect(registeredToolNames(s).sort()).toEqual([
      "audit_library",
      "get_crate_tracks",
      "get_tracks",
      "list_crates",
      "list_libraries",
      "run_sql",
      "search_tracks",
    ]);
  });

  // Registration depends only on the flag, not on what the library holds --
  // the fixture here is the bare makeMasterFixture with no tracks or crates.
  it("registers the four write tools only with --allow-writes", () => {
    const without = createServer(cli());
    expect(registeredToolNames(without).sort()).toEqual([
      "audit_library",
      "get_crate_tracks",
      "get_tracks",
      "list_crates",
      "list_libraries",
      "search_tracks",
    ]);

    const s = createServer(cli({ allowWrites: true }));
    expect(registeredToolNames(s).sort()).toEqual([
      "apply_changes",
      "audit_library",
      "discard_changes",
      "get_crate_tracks",
      "get_tracks",
      "list_crates",
      "list_libraries",
      "preview_changes",
      "search_tracks",
      "stage_crate",
    ]);
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

  // B1: both tools declare outputSchema. The client validates
  // structuredContent against it once it has a validator cached, which only
  // happens after listTools() (cacheToolMetadata) -- so this must call
  // listTools() first, or it would exercise nothing (see
  // callToolAfterListingOverTheWire()'s doc comment). If the declared shape
  // did not match what these tools actually return, client.callTool() would
  // reject with McpError(InvalidParams, "does not match the tool's output
  // schema") instead of resolving.
  it("a successful list_libraries call validates against its declared outputSchema", async () => {
    const s = createServer(cli());
    const result = await callToolAfterListingOverTheWire(s, "list_libraries", {});
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown>;
    expect(out.active).toEqual(expect.any(String));
    expect(Array.isArray(out.libraries)).toBe(true);
  });

  it("a successful run_sql call validates against its declared outputSchema", async () => {
    const s = createServer(cli({ allowRawSql: true }));
    const result = await callToolAfterListingOverTheWire(s, "run_sql", { sql: "SELECT 1 AS one" });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown>;
    expect(out.columns).toEqual(["one"]);
    expect(out.rows).toEqual([[1]]);
    expect(out.truncated).toBe(false);
    expect(out.generation).toEqual(expect.any(String));
  });

  // An error response never carries structuredContent at all (see
  // toCallToolResult in ../src/envelope.ts), so it never has to fit the
  // success shape declared above -- and, unlike the two tests just above,
  // this holds regardless of whether listTools() ran first. The dedicated
  // regression tests further down make that ordering explicit; this one
  // just confirms the error still arrives over the wire, using the simpler
  // helper.
  it("an error response is delivered without structuredContent", async () => {
    const s = createServer(cli({ allowRawSql: true }));
    const out = await callToolOverTheWire(s, "run_sql", { sql: "DELETE FROM asset" });
    expect(out.error).toMatchObject({ code: "invalid_argument" });
  });

  // found[0] could be a 3.x directory: joining "master.sqlite" onto it and
  // handing that to runSql() would surface a generic snapshot_failed instead
  // of naming the real problem. A 3.x-only result is not "not found" either:
  // it must name the detected version so the user does not retry the same
  // --library and get the same unhelpful answer.
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
  // alongside the existing candidates.
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

  // Regression test for the outputSchema/error bug: the MCP client's
  // structuredContent validator is only built once listTools() has run
  // (cacheToolMetadata), and it validates whatever it finds in
  // structuredContent against outputSchema without checking isError --
  // contrary to its own comment ("Only validate structured content if
  // present (not when there's an error)"). A real client always calls
  // tools/list before its first tool call, so any test that skips
  // listTools() (like callToolOverTheWire() above) cannot see this failure
  // at all -- that ordering dependence is exactly what let the original bug
  // through review. Calling listTools() first is therefore load-bearing:
  // deleting it turns this from "would have caught the regression" into
  // "passes either way". Fixed by never putting an error in
  // structuredContent (see toCallToolResult in ../src/envelope.ts) rather
  // than by widening outputSchema -- confirmed by reverting that change and
  // re-running this test, which then fails with MCP error -32602 ("does not
  // match the tool's output schema") instead of resolving.
  it("an error from list_libraries survives a real client that already called listTools()", async () => {
    const s = createServer(cli({ library: "/no/such/serato-library-dir" }));
    const result = await callToolAfterListingOverTheWire(s, "list_libraries", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(payload.error.code).toBe("library_not_found");
  });

  it("an error from run_sql survives a real client that already called listTools()", async () => {
    const s = createServer(cli({ allowRawSql: true }));
    const result = await callToolAfterListingOverTheWire(s, "run_sql", {
      sql: "DELETE FROM asset",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(payload.error.code).toBe("invalid_argument");
  });
  // The whole point of serving tools/call ourselves (see the note on
  // dispatch in ../src/server.ts): a malformed argument now comes back as a
  // value from the taxonomy instead of the SDK's own prose. Measured before
  // the change, the same call produced isError text reading "MCP error
  // -32602: Input validation error: Invalid arguments for tool run_sql: Too
  // big: expected number to be <=500 at limit" -- readable, but with no
  // error.code for the model to dispatch on and no way for any helper of
  // ours to shape it. listTools() runs first because that is what a real
  // client does, and because it is what builds the structuredContent
  // validator that must not touch this response.
  it("a malformed argument comes back as invalid_argument, not as SDK prose", async () => {
    const s = createServer(cli({ allowRawSql: true }));
    const result = await callToolAfterListingOverTheWire(s, "run_sql", {
      sql: "SELECT 1",
      limit: 1000,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(payload.error.code).toBe("invalid_argument");
    expect(payload.error.details.reason).toBe("schema_violation");
    expect(payload.error.details.issues[0].path).toBe("limit");
  });

  // Taking the handlers over means nothing else generates the advertised
  // schema any more, so a mistake there would silently strip the model of
  // every constraint it plans calls against -- and every other test in this
  // file would still pass. The expected object is the exact schema the SDK's
  // own conversion advertised before the change, captured from a live
  // client on 2026-09-06.
  it("still advertises the full input schema, constraints included", async () => {
    const s = createServer(cli({ allowRawSql: true }));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([s.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const runSqlTool = tools.find((t) => t.name === "run_sql");
      expect(runSqlTool?.inputSchema).toEqual({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          sql: { type: "string", minLength: 1 },
          params: { type: "array", items: { type: ["string", "number", "null"] } },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["sql"],
      });
      expect(runSqlTool?.annotations).toMatchObject({ readOnlyHint: true });
      expect(runSqlTool?.title).toBe("Run read-only SQL");
    } finally {
      await client.close();
    }
  });

  // A gated-off tool is indistinguishable from one that never existed, and
  // both must answer rather than hang or crash the connection.
  it("answers a call to a tool that is not registered", async () => {
    const s = createServer(cli());
    const result = await callToolAfterListingOverTheWire(s, "run_sql", { sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect((result.content as { type: string; text: string }[])[0].text).toContain("not found");
  });
});
