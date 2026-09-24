import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { makeDemoLibrary } from "../scripts/make-demo-library.js";
import { createServer } from "../src/server.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/**
 * The demo library is what a directory reviewer is told to try the server
 * on, and docs/reviewer-guide.md states what each question returns. These
 * tests are what keeps those statements true: they drive the real server
 * over a real MCP client, the way a client would.
 */
async function connect(libraryDir: string, allowWrites = false) {
  const state = tmp("serato-demo-state-");
  const server = createServer({
    library: libraryDir,
    roots: [],
    cacheDir: state,
    stateDir: state,
    allowWrites,
    allowRawSql: false,
  });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).toBeFalsy();
    return r.structuredContent as Record<string, unknown>;
  };
  return { client, call };
}

type Track = { id: number; title: string; artist: string; bpm: number | null; key: string | null };

describe("demo library", () => {
  it("is the same library on every run", () => {
    const rows = (dir: string) => {
      const lib = makeDemoLibrary(dir);
      const db = new DatabaseSync(join(lib.libraryDir, "master.sqlite"), { readOnly: true });
      try {
        return db
          .prepare(
            "SELECT external_id, name, artist, album, genre, bpm, key_value, key, time_added, is_missing FROM asset ORDER BY external_id",
          )
          .all();
      } finally {
        db.close();
      }
    };
    expect(rows(tmp("serato-demo-a-"))).toEqual(rows(tmp("serato-demo-b-")));
  });

  it("refuses a folder that is neither empty nor an earlier demo", () => {
    const dir = tmp("serato-demo-busy-");
    writeFileSync(join(dir, "master.sqlite"), "not ours");
    expect(() => makeDemoLibrary(dir)).toThrow(/not empty/);
    // And replaces an earlier demo in place.
    const again = tmp("serato-demo-again-");
    makeDemoLibrary(again);
    expect(() => makeDemoLibrary(again)).not.toThrow();
  });

  it("writes an audio file for every track except the missing ones", () => {
    const lib = makeDemoLibrary(tmp("serato-demo-files-"));
    const absent = lib.tracks
      .filter((t) => !existsSync(`/${t.portableId}`))
      .map((t) => t.externalId);
    expect(absent.sort((a, b) => a - b)).toEqual([9, 29, 41, 50]);
  });

  it("answers list_crates, search_tracks and audit_library as the guide says", async () => {
    const lib = makeDemoLibrary(tmp("serato-demo-read-"));
    const { client, call } = await connect(lib.libraryDir);
    try {
      const crates = (await call("list_crates")).crates as { name: string; track_count: number }[];
      expect(crates.map((c) => [c.name, c.track_count])).toEqual([
        ["Warm Up", 10],
        ["Peak Time", 12],
        ["Hip-Hop Set", 8],
        ["Liquid DnB", 6],
      ]);

      const warmUp = (await call("get_crate_tracks", { crate_name: "Warm Up" })).tracks as Track[];
      expect(warmUp[0]).toMatchObject({
        title: "Paper Engine",
        artist: "Kitefall",
        bpm: 112,
        key: "9A",
      });
      expect(warmUp).toHaveLength(10);
      expect(warmUp.map((t) => t.bpm)).toEqual([112, 113, 113, 116, 116, 117, 118, 118, 118, 118]);

      const inRange = (
        await call("search_tracks", { bpm: { min: 118, max: 126 }, key: { camelot: ["8A", "9A"] } })
      ).tracks as Track[];
      expect(inRange.map((t) => `${t.artist} - ${t.title} ${t.bpm} ${t.key}`).sort()).toEqual([
        "Harbor Sine - Paper Lantern 120 8A",
        "Saltwire - Paper Garden 125 8A",
        "Velvet Orrery - Hollow Signal 118 8A",
      ]);

      const compatible = (
        await call("search_tracks", { key: { compatible_with: "8A" }, bpm: { around: 124 } })
      ).tracks as Track[];
      expect(compatible).toHaveLength(12);
      for (const t of compatible) expect(["7A", "8A", "9A", "8B"]).toContain(t.key);

      const audit = (await call("audit_library")).checks as {
        name: string;
        count: number;
        sample_ids?: number[];
        sample_groups?: number[][];
      }[];
      const check = (name: string) => audit.find((c) => c.name === name);
      expect(check("missing_bpm")).toMatchObject({ count: 3, sample_ids: [7, 19, 33] });
      expect(check("missing_key")).toMatchObject({ count: 3, sample_ids: [11, 27, 45] });
      expect(check("key_unreadable_by_serato")).toMatchObject({ count: 2, sample_ids: [14, 38] });
      // Open Key 6m and 3d, which Serato cannot parse and this server can.
      const openKey = (await call("get_tracks", { ids: [14, 38] })).found as Track[];
      expect(openKey.map((t) => t.key)).toEqual(["1A", "10B"]);
      expect(check("broken_paths")).toMatchObject({ count: 3, sample_ids: [9, 29, 50] });
      expect(check("not_in_any_crate")?.count).toBe(23);
      const groups = (check("duplicates")?.sample_groups ?? []).map((g) =>
        [...g].sort((a, b) => a - b),
      );
      expect(groups.sort((a, b) => a[0] - b[0])).toEqual([
        [2, 57],
        [16, 58],
        [23, 59],
      ]);

      // The one file Serato has not flagged is found only on disk.
      const onDisk = (
        await call("audit_library", { checks: ["broken_paths"], check_filesystem: true })
      ).checks as { count: number; sample_ids: number[] }[];
      expect(onDisk[0].count).toBe(4);
      expect([...onDisk[0].sample_ids].sort((a, b) => a - b)).toEqual([9, 29, 41, 50]);
    } finally {
      await client.close();
    }
  });

  it("takes a crate through stage, preview and apply", async () => {
    const lib = makeDemoLibrary(tmp("serato-demo-write-"));
    const { client, call } = await connect(lib.libraryDir, true);
    try {
      const staged = await call("stage_crate", { name: "Friday Opening", track_ids: [1, 37, 46] });
      expect(staged.track_count).toBe(3);
      const preview = await call("preview_changes", { format: "detail" });
      expect(preview.summary).toBe("1 crate, 3 tracks");
      await call("apply_changes", { confirm: true });
      const root = new DatabaseSync(join(lib.libraryDir, "root.sqlite"), { readOnly: true });
      try {
        expect(
          root.prepare("SELECT 1 FROM container WHERE name = 'Friday Opening'").get(),
        ).toBeTruthy();
      } finally {
        root.close();
      }
    } finally {
      await client.close();
    }
  });
});
