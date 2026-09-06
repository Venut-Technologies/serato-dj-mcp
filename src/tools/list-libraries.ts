import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { discover, type LibraryInfo } from "../discovery/index.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { isSeratoError, type SeratoError } from "../errors.js";
import { volumeRootFromDatabaseUri } from "../paths.js";
import { introspect } from "../schema/index.js";

export const listLibrariesInput = z.object({});

export const listLibrariesDescription =
  "List the Serato libraries this server can see, with their version, schema and locations. " +
  "Paths here are NOT redacted: copy one into --library to pin the server to it.";

export type LibraryEntry = LibraryInfo & {
  locations: { uri: string; volumeRoot: string }[];
  /** null, not 0, for anything not a readable 4.x library: zero is a claim
   *  about the library's contents, null is an absence of one. */
  track_count: number | null;
};

const libraryEntrySchema = z.object({
  path: z.string(),
  uuid: z.string(),
  version: z.enum(["4.x", "3.x"]),
  schema: z.number().nullable(),
  status: z.enum(["ok", "unreadable"]),
  error: z.string().optional(),
  locations: z.array(z.object({ uri: z.string(), volumeRoot: z.string() })),
  track_count: z.number().nullable(),
});

// list_libraries is the one tool exempted from carrying `generation` (spec
// 4.0): it is not bound to a single snapshot, it lists all of them.
export const listLibrariesOutput = z.object({
  libraries: z.array(libraryEntrySchema),
  active: z.string().nullable(),
  warnings: z.array(warningSchema).optional(),
});

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

/**
 * Takes no arguments, and still parses them: `raw` goes through the same
 * helper every other tool uses (../args.ts), so "this tool accepts nothing"
 * is a statement its schema makes rather than one the dispatch layer makes
 * on its behalf. `opts` is server configuration, not model input, and is
 * therefore not part of that schema.
 */
export function listLibraries(
  raw: unknown,
  opts: {
    library?: string;
    roots: string[];
  },
): ({ libraries: LibraryEntry[]; active: string | null } & { warnings?: Warning[] }) | SeratoError {
  const args = parseToolArgs(listLibrariesInput, raw);
  if (isSeratoError(args)) return args;

  const found = discover({ library: opts.library, roots: opts.roots });
  if (isSeratoError(found)) return found;

  const warnings: Warning[] = [];
  const libraries: LibraryEntry[] = found.map((lib) => {
    // null, not 0: a 3.x library or an unreadable master.sqlite has no
    // trustworthy count to report, and 0 would be indistinguishable from a
    // genuinely empty 4.x library.
    let trackCount: number | null = null;
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
        // One SELECT on the handle already open for introspection, rather
        // than a second open elsewhere for the same library.
        trackCount = (db.prepare("SELECT count(*) AS n FROM asset").get() as { n: number }).n;
      } catch {
        // Already reflected by status; nothing further to say.
      } finally {
        db?.close();
      }
    }
    if (lib.version !== "4.x") return { ...lib, locations: [], track_count: null };

    const { locations, failed, error } = locationsOf(lib.path);
    if (failed) {
      warnings.push({
        code: "locations_unavailable",
        message: `could not read locations for ${lib.path}${error ? `: ${error}` : ""}`,
        details: { path: lib.path, error },
      });
    }
    return { ...lib, locations, track_count: trackCount };
  });

  const active = libraries.find((l) => l.version === "4.x" && l.status === "ok")?.uuid ?? null;
  return ok({ libraries, active }, undefined, warnings);
}
