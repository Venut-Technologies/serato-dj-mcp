import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { existingCrateId, findAnchors, resolveSpaceAssets, rootGeneration } from "../apply/root.js";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { isStreamingPortableId } from "../paths.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";
import { sameCrateName, validateCrateName } from "../stage/name.js";
import { loadStage, type Stage, type StagedCrate, saveStage } from "../stage/store.js";

/** Decision 12: bounded, like every other model-supplied list since the P2
 *  review found an unbounded `q` could stall the server for 36 seconds. */
export const MAX_STAGE_TRACKS = 1000;

export type WriteCtx = ReadCtx & { stateDir: string };

export const stageCrateInput = z.object({
  name: z.string().min(1).max(512),
  track_ids: z.array(z.number().int()).min(1).max(MAX_STAGE_TRACKS),
  generation: z.string().max(64).optional(),
});

export const stageCrateOutput = z.object({
  staged_id: z.string(),
  library_id: z.string(),
  name: z.string(),
  track_count: z.number(),
  tracks: z.array(z.object({ id: z.number(), title: z.string(), artist: z.string() })),
  root_generation: z.string(),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const stageCrateDescription =
  "Stage a new crate in the Serato Library space from track ids returned by search_tracks, " +
  "get_tracks or get_crate_tracks. Nothing is written to the library: apply_changes does that, " +
  "and only while Serato is closed. The response lists every staged track by title and artist -- " +
  "check it. The whole call is refused if any id is unknown, a streaming track, or not part of " +
  "the library on this computer's disk. Nested crates are not supported: the crate is created at " +
  "the top level. Name: 1-128 characters, no / : or %%.";

type AssetRow = {
  id: number;
  location_id: number;
  portable_id: string;
  name: string | null;
  artist: string | null;
  third_party_type: number | null;
};

type Rejection = { track_id: number; reason: string };

export async function stageCrate(
  raw: unknown,
  ctx: WriteCtx,
): Promise<
  | ({
      staged_id: string;
      library_id: string;
      name: string;
      track_count: number;
      tracks: { id: number; title: string; artist: string }[];
      root_generation: string;
    } & { generation?: string; warnings?: Warning[] })
  | SeratoError
> {
  const args = parseToolArgs(stageCrateInput, raw);
  if (isSeratoError(args)) return args;
  const named = validateCrateName(args.name);
  if (isSeratoError(named)) return named;

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);

    const ids = [...new Set(args.track_ids)];
    if (ids.length < args.track_ids.length) {
      warnings.push({
        code: "duplicates_removed",
        message: `${args.track_ids.length - ids.length} repeated track ids were staged once`,
        details: { removed: args.track_ids.length - ids.length },
      });
    }

    const rows = handle.db
      .prepare(
        `SELECT id, location_id, portable_id, name, artist, third_party_type
           FROM asset WHERE id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(...(ids as never[])) as AssetRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return err("unknown_ids", `no track with id ${missing.join(", ")}`, { missing_ids: missing });
    }

    // The boot disk's store is the connection whose database_uri names
    // root.sqlite (spec 2.3); a location.sqlite is another volume, with its
    // own store this protocol does not write.
    const bootLocations = new Set(
      handle.schema.tables.has("connection")
        ? (
            handle.db
              .prepare("SELECT location_id FROM connection WHERE database_uri LIKE '%/root.sqlite'")
              .all() as { location_id: number }[]
          ).map((r) => r.location_id)
        : [],
    );

    const rejections: Rejection[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row === undefined) continue;
      if (isStreamingPortableId(row.portable_id) || (row.third_party_type ?? 0) !== 0) {
        rejections.push({ track_id: id, reason: "streaming" });
      } else if (!bootLocations.has(row.location_id)) {
        rejections.push({ track_id: id, reason: "not_on_library_disk" });
      }
    }

    const rootPath = join(handle.libraryPath, "root.sqlite");
    let root: DatabaseSync | undefined;
    try {
      root = new DatabaseSync(rootPath, { readOnly: true });
      root.exec("PRAGMA busy_timeout = 3000");
      const anchors = findAnchors(root);
      if (isSeratoError(anchors)) return anchors;

      const rejected = new Set(rejections.map((r) => r.track_id));
      const candidates = ids.filter((id) => !rejected.has(id));
      const { missing: notInSpace } = resolveSpaceAssets(
        root,
        anchors.spaceId,
        candidates.map((id) => byId.get(id)?.portable_id ?? ""),
      );
      const notInSpaceSet = new Set(notInSpace);
      for (const id of candidates) {
        if (notInSpaceSet.has(byId.get(id)?.portable_id ?? "")) {
          rejections.push({ track_id: id, reason: "not_in_serato_library_space" });
        }
      }
      if (rejections.length > 0) {
        // Spec 3.5: a partially created crate is worse than a refusal.
        return err("write_refused", "some tracks cannot be written into a crate", {
          reason: rejections[0].reason,
          rejected_track_ids: rejections.map((r) => r.track_id),
          rejected: rejections,
        });
      }

      const conflict = existingCrateId(root, anchors.rootContainerId, named.name);
      if (conflict !== null) {
        warnings.push({
          code: "crate_name_conflict_preview",
          message: `a crate named "${named.name}" already exists; apply_changes will refuse unless it is renamed`,
          details: { existing_container_id: conflict },
        });
      }

      // Decision 1: resolve against the current snapshot and say the library
      // moved, rather than refusing a model that searched a moment ago.
      if (args.generation !== undefined && args.generation !== handle.snapshot.generation) {
        warnings.push({
          code: "snapshot_advanced",
          message: "the library changed since that search; check the staged titles below",
          details: {
            requested_generation: args.generation,
            generation: handle.snapshot.generation,
          },
        });
      }

      const rootGen = rootGeneration(root, rootPath, handle.libraryId);
      const existing = loadStage(ctx.stateDir, handle.libraryId);
      if (isSeratoError(existing)) return existing;
      const clash = existing?.crates.find((c) => sameCrateName(c.name, named.name));
      if (clash !== undefined) {
        return err("invalid_crate_name", `a crate named "${clash.name}" is already staged`, {
          reason: "already_staged",
          staged_id: clash.staged_id,
        });
      }

      const crate: StagedCrate = {
        staged_id: randomUUID().slice(0, 8),
        name: named.name,
        tracks: ids.map((id) => {
          const row = byId.get(id) as AssetRow;
          return {
            track_id: id,
            portable_id: row.portable_id,
            title: row.name ?? "",
            artist: row.artist ?? "",
          };
        }),
        staged_at: new Date().toISOString(),
      };
      const stage: Stage = {
        schema_version: 1,
        library_id: handle.libraryId,
        library_path: handle.libraryPath,
        generation: handle.snapshot.generation,
        root_generation: rootGen,
        crates: [...(existing?.crates ?? []), crate],
      };
      const saved = saveStage(ctx.stateDir, stage);
      if (isSeratoError(saved)) return saved;

      return ok(
        {
          staged_id: crate.staged_id,
          library_id: handle.libraryId,
          name: crate.name,
          track_count: crate.tracks.length,
          tracks: crate.tracks.map((t) => ({ id: t.track_id, title: t.title, artist: t.artist })),
          root_generation: rootGen,
        },
        handle.snapshot.generation,
        warnings,
      );
    } finally {
      root?.close();
    }
  });
}
