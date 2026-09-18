import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, type SeratoError } from "../errors.js";
import { writeFileAtomic } from "../stage/store.js";
import type { BackupPaths } from "./backup.js";

export type ManifestCrate = {
  staged_id: string;
  name: string;
  track_count: number;
  /** null until committed: the id exists only after the INSERT. */
  container_id: number | null;
};

/**
 * One line per apply, with every crate it wrote: the manifest line matches
 * the unit of atomicity, one transaction for the whole batch, not the crate
 * count. An earlier per-crate design assumed every apply created exactly one
 * crate, which need not hold.
 */
export type ManifestEntry = {
  schema_version: 1;
  op_id: string;
  ts: string;
  library_id: string;
  crates: ManifestCrate[];
  backup_paths: BackupPaths;
  /** "aborted" is a state beyond just "intent" and "committed": a refusal
   *  found inside the transaction is known not to be committed, and leaving
   *  it as an intent would make it look like a crash. */
  commit_state: "intent" | "committed" | "aborted";
  abort_reason?: string;
};

export function manifestPath(stateDir: string, libraryId: string): string {
  return join(stateDir, "manifests", `${libraryId}.jsonl`);
}

export function readManifest(stateDir: string, libraryId: string): ManifestEntry[] {
  const path = manifestPath(stateDir, libraryId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ManifestEntry);
}

function rewrite(
  stateDir: string,
  libraryId: string,
  entries: ManifestEntry[],
): true | SeratoError {
  try {
    // Whole-file rewrite through an atomic rename, not an append: an append
    // torn by a crash leaves a half line that poisons every later read.
    writeFileAtomic(
      manifestPath(stateDir, libraryId),
      `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
    return true;
  } catch (e) {
    return err("write_failed_not_committed", `cannot write the manifest: ${String(e)}`, {
      stage: "manifest",
    });
  }
}

/**
 * Every change is read, modify, rewrite. readManifest throws on a damaged
 * line, and change() can throw too on a line that parses but has the wrong
 * shape (e.g. missing crates) -- both have to come back as a value here:
 * markCommitted runs after COMMIT, and a throw there would fail a call whose
 * write succeeded -- inviting a retry that the name-conflict check then
 * refuses.
 */
function update(
  stateDir: string,
  libraryId: string,
  change: (entries: ManifestEntry[]) => ManifestEntry[],
): true | SeratoError {
  let entries: ManifestEntry[];
  try {
    entries = change(readManifest(stateDir, libraryId));
  } catch (e) {
    return err(
      "write_failed_not_committed",
      `the manifest is unreadable or damaged: ${String(e)}`,
      {
        stage: "manifest",
        path: manifestPath(stateDir, libraryId),
      },
    );
  }
  return rewrite(stateDir, libraryId, entries);
}

/** Written BEFORE BEGIN, so a crash between BEGIN and COMMIT leaves evidence
 *  of what was being attempted. */
export function writeIntent(stateDir: string, entry: ManifestEntry): true | SeratoError {
  return update(stateDir, entry.library_id, (existing) => [
    ...existing,
    { ...entry, commit_state: "intent" },
  ]);
}

export function markCommitted(
  stateDir: string,
  libraryId: string,
  opId: string,
  containerIds: Map<string, number>,
): true | SeratoError {
  return update(stateDir, libraryId, (entries) =>
    entries.map((e) =>
      e.op_id !== opId
        ? e
        : {
            ...e,
            commit_state: "committed" as const,
            crates: e.crates.map((c) => ({
              ...c,
              container_id: containerIds.get(c.staged_id) ?? null,
            })),
          },
    ),
  );
}

export function markAborted(
  stateDir: string,
  libraryId: string,
  opId: string,
  reason: string,
): true | SeratoError {
  return update(stateDir, libraryId, (entries) =>
    entries.map((e) =>
      e.op_id !== opId ? e : { ...e, commit_state: "aborted" as const, abort_reason: reason },
    ),
  );
}
