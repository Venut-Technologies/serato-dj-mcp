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

      const discarded = await client.callTool({ name: "discard_changes", arguments: {} });
      expect(discarded.isError).toBeFalsy();
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
});
