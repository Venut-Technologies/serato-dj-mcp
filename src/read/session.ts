import { DatabaseSync } from "node:sqlite";
import { resolveLibrary } from "../discovery/index.js";
import type { Warning } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { volumeRootFromDatabaseUri } from "../paths.js";
import { introspect, type SchemaInfo } from "../schema/index.js";
import { type Snapshot, takeSnapshot } from "../snapshot/index.js";

export type ReadCtx = { library?: string; roots?: string[]; cacheDir: string };

export type ReadHandle = {
  db: DatabaseSync;
  schema: SchemaInfo;
  snapshot: Snapshot;
  libraryPath: string;
  /** The library's stable id (a short hash of its path, see discovery). The
   *  stage, the manifest and the backups are all keyed by it. */
  libraryId: string;
  /** location_id -> volume root, from connection.database_uri. location.path
   *  is NULL in every observed row, so this is the only source. */
  volumeRoots: Map<number, string>;
};

/**
 * The single read path: resolve, snapshot, open, introspect, run, close.
 *
 * Every read tool goes through this, so a change to how reads work (a new
 * pragma, a different snapshot policy, another derived table) has exactly one
 * place to happen. It also guarantees the handle is closed on every exit,
 * including a throw from the callback -- an earlier version leaked a file
 * descriptor three separate times by closing only on the success path.
 */
export async function readSession<T>(
  ctx: ReadCtx,
  fn: (handle: ReadHandle) => T | SeratoError,
): Promise<T | SeratoError> {
  const lib = resolveLibrary({ library: ctx.library, roots: ctx.roots });
  if (isSeratoError(lib)) return lib;

  const snapshot = await takeSnapshot(lib.masterPath, ctx.cacheDir);
  if (isSeratoError(snapshot)) return snapshot;

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(snapshot.path, { readOnly: true });
  } catch (e) {
    return err(
      "snapshot_failed",
      `cannot open snapshot: ${e instanceof Error ? e.message : String(e)}`,
      { attempts: 1 },
    );
  }

  try {
    // node:sqlite is synchronous and has no interrupt(), so a runaway query
    // blocks the server. busy_timeout plus the limit ceilings is the whole
    // defence.
    db.exec("PRAGMA busy_timeout = 3000");
    const schema = introspect(db);
    return fn({
      db,
      schema,
      snapshot,
      libraryPath: lib.path,
      libraryId: lib.uuid,
      volumeRoots: volumeRoots(db, schema.tables),
    });
  } catch (e) {
    // Errors are values (errors.ts). Anything thrown from here is our own
    // bug or a damaged snapshot, and both are the caller's "the copy could
    // not be read" case rather than a protocol failure.
    return err("snapshot_failed", `read failed: ${e instanceof Error ? e.message : String(e)}`, {
      attempts: 1,
    });
  } finally {
    db.close();
  }
}

function volumeRoots(db: DatabaseSync, tables: Set<string>): Map<number, string> {
  const roots = new Map<number, string>();
  // Guard against unknown schema variants that lack or rename the connection
  // table: unfamiliar schemas warn and degrade, never refuse.
  if (!tables.has("connection")) return roots;
  const rows = db.prepare("SELECT location_id, database_uri FROM connection").all() as {
    location_id: number;
    database_uri: string;
  }[];
  for (const row of rows) {
    try {
      roots.set(row.location_id, volumeRootFromDatabaseUri(row.database_uri));
    } catch {
      // An unrecognised database_uri costs that location's absolute paths,
      // nothing else. The track is still listed, with its portable_id.
    }
  }
  return roots;
}

/** An unfamiliar schema is reported in warnings[], never as a refusal. */
export function schemaWarnings(handle: ReadHandle): Warning[] {
  if (handle.schema.known) return [];
  return [
    {
      code: "schema_unknown",
      message: `unknown Serato schema user_version ${handle.schema.userVersion}; reads may be incomplete`,
      details: { path: handle.libraryPath, user_version: handle.schema.userVersion },
    },
  ];
}
