import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ManifestEntry,
  manifestPath,
  markAborted,
  markCommitted,
  readManifest,
  writeIntent,
} from "../../src/apply/manifest.js";
import { isSeratoError } from "../../src/errors.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-manifest-"));

const entry = (opId: string): ManifestEntry => ({
  schema_version: 1,
  op_id: opId,
  ts: "2026-09-14T10:00:00.000Z",
  library_id: "lib000000001",
  crates: [{ staged_id: "s1", name: "Gigs 2026", track_count: 3, container_id: null }],
  backup_paths: { root: "/b/root.sqlite", master: "/b/master.sqlite" },
  commit_state: "intent",
});

describe("manifest", () => {
  it("records an intent before the write and marks it committed after", () => {
    const state = tmp();
    expect(writeIntent(state, entry("op1"))).toBe(true);
    expect(readManifest(state, "lib000000001")).toEqual([entry("op1")]);

    expect(markCommitted(state, "lib000000001", "op1", new Map([["s1", 42]]))).toBe(true);
    const [after] = readManifest(state, "lib000000001");
    expect(after.commit_state).toBe("committed");
    expect(after.crates[0].container_id).toBe(42);
  });

  // An intent without a committed mark is exactly the evidence needed after
  // a crash between BEGIN and COMMIT. Earlier operations must survive every
  // later rewrite of the file.
  it("keeps earlier operations when a later one is added or committed", () => {
    const state = tmp();
    writeIntent(state, entry("op1"));
    markCommitted(state, "lib000000001", "op1", new Map([["s1", 1]]));
    writeIntent(state, entry("op2"));
    const all = readManifest(state, "lib000000001");
    expect(all.map((e) => [e.op_id, e.commit_state])).toEqual([
      ["op1", "committed"],
      ["op2", "intent"],
    ]);
  });

  it("writes one JSON object per line and leaves no temporary files", () => {
    const state = tmp();
    writeIntent(state, entry("op1"));
    writeIntent(state, entry("op2"));
    expect(readdirSync(dirname(manifestPath(state, "lib000000001")))).toEqual([
      "lib000000001.jsonl",
    ]);
  });

  // A refusal found inside the transaction (a name conflict, a vanished
  // track) is KNOWN not to be committed. Leaving it as a bare intent would
  // make it indistinguishable from a crash between BEGIN and COMMIT, which is
  // the one case an intent line exists to flag.
  it("marks a refused operation as aborted, with the reason", () => {
    const state = tmp();
    writeIntent(state, entry("op1"));
    expect(markAborted(state, "lib000000001", "op1", "crate_name_conflict")).toBe(true);
    const [after] = readManifest(state, "lib000000001");
    expect(after.commit_state).toBe("aborted");
    expect(after.abort_reason).toBe("crate_name_conflict");
  });

  // markCommitted runs after COMMIT. A damaged line must come back as a value
  // apply_changes can turn into a warning, never as a throw that fails a call
  // whose write succeeded.
  it("returns an error value, never a throw, when the manifest is damaged", () => {
    const state = tmp();
    const path = manifestPath(state, "lib000000001");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json\n");
    const results = [
      writeIntent(state, entry("op1")),
      markCommitted(state, "lib000000001", "op1", new Map()),
      markAborted(state, "lib000000001", "op1", "crate_name_conflict"),
    ];
    for (const r of results) {
      expect(isSeratoError(r) && r.error.details?.stage).toBe("manifest");
    }
  });

  it("reads an absent manifest as empty -- its absence is not an error", () => {
    expect(readManifest(tmp(), "lib000000001")).toEqual([]);
  });

  // Valid JSON of the wrong shape gets past JSON.parse and fails inside the
  // transform instead. After COMMIT that must still be a value, not a throw.
  it("returns an error value, never a throw, for a line that parses but has the wrong shape", () => {
    const state = tmp();
    const path = manifestPath(state, "lib000000001");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"op_id":"op1"}\n');
    const r = markCommitted(state, "lib000000001", "op1", new Map());
    expect(isSeratoError(r) && r.error.details?.stage).toBe("manifest");
  });
});
