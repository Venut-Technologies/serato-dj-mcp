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

/** Locations live in master.sqlite; the volume root of each comes from
 *  connection.database_uri, because location.path is NULL. */
function locationsOf(dir: string): { uri: string; volumeRoot: string }[] {
  try {
    const db = new DatabaseSync(join(dir, "master.sqlite"), { readOnly: true });
    const rows = db.prepare("SELECT database_uri FROM connection").all() as {
      database_uri: string;
    }[];
    db.close();
    return rows.map((r) => {
      try {
        return { uri: r.database_uri, volumeRoot: volumeRootFromDatabaseUri(r.database_uri) };
      } catch {
        return { uri: r.database_uri, volumeRoot: "" };
      }
    });
  } catch {
    return [];
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
      try {
        const db = new DatabaseSync(join(lib.path, "master.sqlite"), { readOnly: true });
        const info = introspect(db);
        db.close();
        if (!info.known) {
          warnings.push({
            code: "schema_unknown",
            message: `unknown Serato schema user_version ${info.userVersion}; reads may be incomplete`,
            details: { path: lib.path, user_version: info.userVersion },
          });
        }
      } catch {
        // Already reflected by status; nothing further to say.
      }
    }
    return { ...lib, locations: lib.version === "4.x" ? locationsOf(lib.path) : [] };
  });

  const active = libraries.find((l) => l.version === "4.x" && l.status === "ok")?.uuid ?? null;
  return ok({ libraries, active }, undefined, warnings);
}
