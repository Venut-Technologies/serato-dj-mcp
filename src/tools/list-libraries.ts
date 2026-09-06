import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { discover, type LibraryInfo } from "../discovery/index.js";
import { ok, type Warning } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { volumeRootFromDatabaseUri } from "../paths.js";
import { introspect } from "../schema/index.js";

export const listLibrariesInput = z.object({});

export const listLibrariesDescription =
  "List the Serato libraries this server can see, with their version, schema and locations. " +
  "Paths here are NOT redacted: copy one into --library to pin the server to it.";

export type LibraryEntry = LibraryInfo & {
  locations: { uri: string; volumeRoot: string }[];
};

type LocationsResult = {
  locations: { uri: string; volumeRoot: string }[];
  /** true only when the connection table itself couldn't be read -- a
   *  genuinely empty table reports failed: false, locations: []. Collapsing
   *  both into a bare [] would make "no locations recorded" and "couldn't
   *  read locations" indistinguishable to the caller. */
  failed: boolean;
  error?: string;
};

/**
 * Locations live in master.sqlite; the volume root of each comes from
 * connection.database_uri, because location.path is NULL.
 *
 * node:sqlite opens lazily: `new DatabaseSync` succeeds even for a file that
 * isn't a valid database, and the throw only comes from the first statement
 * that actually reads it. db is declared before the try and closed in a
 * `finally` -- same idiom as detectLibrary() in ../discovery/index.ts -- so
 * that the throwing path closes the handle too, not just the success path.
 */
function locationsOf(dir: string): LocationsResult {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(dir, "master.sqlite"), { readOnly: true });
    const rows = db.prepare("SELECT database_uri FROM connection").all() as {
      database_uri: string;
    }[];
    return {
      failed: false,
      locations: rows.map((r) => {
        try {
          return { uri: r.database_uri, volumeRoot: volumeRootFromDatabaseUri(r.database_uri) };
        } catch {
          return { uri: r.database_uri, volumeRoot: "" };
        }
      }),
    };
  } catch (e) {
    return { locations: [], failed: true, error: e instanceof Error ? e.message : String(e) };
  } finally {
    db?.close();
  }
}

export function listLibraries(opts: {
  library?: string;
  roots: string[];
}):
  | ({ libraries: LibraryEntry[]; active: string | null } & { warnings?: Warning[] })
  | SeratoError {
  const found = discover({
    library: opts.library,
    roots: opts.roots.length ? opts.roots : undefined,
  });
  if (isSeratoError(found)) return found;

  const warnings: Warning[] = [];
  const libraries: LibraryEntry[] = found.map((lib) => {
    if (lib.version === "4.x" && lib.status === "ok") {
      // Same lazy-open, finally-close idiom as locationsOf() above: introspect()
      // can throw (a future schema it cannot parse, say) after the handle is
      // already live, and closing only on the success path would leak it.
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(join(lib.path, "master.sqlite"), { readOnly: true });
        const info = introspect(db);
        if (!info.known) {
          warnings.push({
            code: "schema_unknown",
            message: `unknown Serato schema user_version ${info.userVersion}; reads may be incomplete`,
            details: { path: lib.path, user_version: info.userVersion },
          });
        }
      } catch {
        // Already reflected by status; nothing further to say.
      } finally {
        db?.close();
      }
    }
    if (lib.version !== "4.x") return { ...lib, locations: [] };

    const { locations, failed, error } = locationsOf(lib.path);
    if (failed) {
      warnings.push({
        code: "locations_unavailable",
        message: `could not read locations for ${lib.path}${error ? `: ${error}` : ""}`,
        details: { path: lib.path, error },
      });
    }
    return { ...lib, locations };
  });

  const active = libraries.find((l) => l.version === "4.x" && l.status === "ok")?.uuid ?? null;
  return ok({ libraries, active }, undefined, warnings);
}
