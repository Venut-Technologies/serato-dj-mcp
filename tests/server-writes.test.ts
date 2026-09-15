import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, registeredToolNames } from "../src/server.js";
import { makeLibraryFixture, ROOT_ANCHOR_CONTAINER_ID } from "./fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-srv-w-"));

function cli(allowWrites: boolean) {
  const dir = tmp();
  const paths = makeLibraryFixture(dir, {
    tracks: [
      { externalId: 1, portableId: "Users/x/1.flac", name: "Rain" },
      { externalId: 2, portableId: "Users/x/2.flac", name: "Storm" },
    ],
  });
  return {
    paths,
    cli: {
      library: dir,
      roots: [],
      cacheDir: tmp(),
      stateDir: tmp(),
      allowWrites,
      allowRawSql: false,
    },
  };
}

const WRITE_TOOLS = ["apply_changes", "discard_changes", "preview_changes", "stage_crate"];

/**
 * Calls a tool the way a real client does: tools/list first, then the call.
 * Copied from tests/server.test.ts (see that file's doc comment on the same
 * helper): client.listTools() runs cacheToolMetadata(), which is what builds
 * the structuredContent validator that destroyed every error response in the
 * outputSchema defect fixed in 62cbab3. A refusal that skipped listTools()
 * first could not have caught that regression.
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

describe("write tools over the wire", () => {
  it("registers the four write tools only with --allow-writes", () => {
    expect(
      registeredToolNames(createServer(cli(false).cli)).filter((n) => WRITE_TOOLS.includes(n)),
    ).toEqual([]);
    const names = registeredToolNames(createServer(cli(true).cli));
    expect(names.filter((n) => WRITE_TOOLS.includes(n)).sort()).toEqual(WRITE_TOOLS);
  });

  // The client validates structuredContent against each tool's advertised
  // outputSchema once listTools() has run (the ordering that let an earlier
  // outputSchema defect through review). Driving all four tools through a real
  // client after listTools() is what proves their schemas match what they
  // return.
  it("stages, previews and applies a crate through a real MCP client", async () => {
    const { cli: c, paths } = cli(true);
    const server = createServer(c);
    const [st, ct] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const apply = tools.find((t) => t.name === "apply_changes");
      expect(apply?.annotations?.readOnlyHint).toBe(false);
      // D1: stage_crate is additive (never destructive); discard_changes
      // deletes the user's staged work, so it alone carries destructiveHint.
      const stage = tools.find((t) => t.name === "stage_crate");
      expect(stage?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
      const discard = tools.find((t) => t.name === "discard_changes");
      expect(discard?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });

      const found = await client.callTool({
        name: "search_tracks",
        arguments: { fields: ["title"] },
      });
      const ids = (found.structuredContent as { tracks: { id: number }[] }).tracks.map((t) => t.id);

      const staged = await client.callTool({
        name: "stage_crate",
        arguments: { name: "Wire Test", track_ids: ids },
      });
      expect(staged.isError).toBeFalsy();

      const preview = await client.callTool({
        name: "preview_changes",
        arguments: { format: "detail" },
      });
      expect(preview.isError).toBeFalsy();
      expect((preview.structuredContent as { pending: unknown[] }).pending).toHaveLength(1);

      const applied = await client.callTool({
        name: "apply_changes",
        arguments: { confirm: true },
      });
      expect(applied.isError).toBeFalsy();
      expect((applied.structuredContent as { restart_required: boolean }).restart_required).toBe(
        true,
      );

      // D4: what was applied leaves the stage -- preview_changes must show
      // nothing pending afterwards.
      const afterApply = await client.callTool({ name: "preview_changes", arguments: {} });
      expect(afterApply.isError).toBeFalsy();
      expect((afterApply.structuredContent as { pending: unknown[] }).pending).toEqual([]);

      const discarded = await client.callTool({ name: "discard_changes", arguments: {} });
      expect(discarded.isError).toBeFalsy();
      expect((discarded.structuredContent as { discarded_ids: string[] }).discarded_ids).toEqual(
        [],
      );
    } finally {
      await client.close();
    }

    const db = new DatabaseSync(paths.rootPath, { readOnly: true });
    const row = db
      .prepare("SELECT name FROM container WHERE parent_id = ? AND type = 1")
      .all(ROOT_ANCHOR_CONTAINER_ID);
    db.close();
    expect(row).toEqual([{ name: "Wire Test" }]);
  });

  // A refusal must survive the same ordering as a success does: listTools()
  // builds the client's structuredContent validator, and that validator is
  // what destroyed every error response in the outputSchema defect fixed in
  // 62cbab3 (see callToolAfterListingOverTheWire() above). Each case here is
  // refused before anything is written or staged, so none of them depends on
  // another having run first.
  it.each([
    { tool: "apply_changes", args: { confirm: false }, code: "invalid_argument" },
    { tool: "stage_crate", args: { name: "Gigs", track_ids: [999999] }, code: "unknown_ids" },
    { tool: "discard_changes", args: { staged_id: "nope" }, code: "unknown_ids" },
    { tool: "preview_changes", args: { format: "bogus" }, code: "invalid_argument" },
  ])("$tool refuses $args over the wire after listTools()", async ({ tool, args, code }) => {
    const server = createServer(cli(true).cli);
    const result = await callToolAfterListingOverTheWire(server, tool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(payload.error.code).toBe(code);
  });
});
