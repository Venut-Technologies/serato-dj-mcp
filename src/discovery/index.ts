import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { expandHome } from "../paths.js";

export type LibraryInfo = {
  path: string;
  uuid: string;
  version: "4.x" | "3.x";
  schema: number | null;
  status: "ok" | "unreadable";
  error?: string;
};

/** macOS layout first, then every mounted volume's _Serato_. Both are only
 *  defaults: --library, SERATO_LIBRARY_PATH and --root all override them. */
export function defaultRoots(): string[] {
  const roots = [join(homedir(), "Library", "Application Support", "Serato", "Library")];
  try {
    for (const v of readdirSync("/Volumes")) {
      const p = join("/Volumes", v, "_Serato_", "Library");
      if (existsSync(p)) roots.push(p);
    }
  } catch {
    // /Volumes does not exist off macOS; not an error.
  }
  return roots;
}

/** A short hash of the absolute path. location.uuid is NULL for a location
 *  that has never connected, so it cannot serve as the library's identity. */
function libraryId(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 12);
}

export function detectLibrary(dir: string): LibraryInfo | null {
  const master = join(dir, "master.sqlite");
  if (existsSync(master)) {
    // node:sqlite opens lazily: for a file that exists but isn't a valid
    // database, `new DatabaseSync` itself succeeds and the throw only comes
    // from the first statement that actually reads it (PRAGMA user_version,
    // below). db is declared before the try and closed in a `finally` so
    // that path -- not just the success path -- closes it too. Measured
    // 2026-09-06: without this, every damaged master.sqlite this function
    // inspects leaks a file descriptor, and discover() inspects one per root
    // on every call.
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(master, { readOnly: true });
      const uv = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      return { path: dir, uuid: libraryId(dir), version: "4.x", schema: uv, status: "ok" };
    } catch (e) {
      return {
        path: dir,
        uuid: libraryId(dir),
        version: "4.x",
        schema: null,
        status: "unreadable",
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      db?.close();
    }
  }
  // 3.x: a binary "database V2" and no SQLite anywhere.
  if (existsSync(join(dir, "database V2"))) {
    return { path: dir, uuid: libraryId(dir), version: "3.x", schema: null, status: "ok" };
  }
  return null;
}

/**
 * The directories discover() looks in, in priority order, with `~` already
 * expanded -- the same list discover() itself computes internally, exposed
 * so a caller that already has a successful LibraryInfo[] (so discover()
 * itself has no error to attach `searched` to) can still report where it
 * looked. `searched` is mandatory on library_not_found, and that stays true
 * just because *some* location, even an unusable one (e.g. a 3.x library),
 * was found.
 */
export function searchLocations(opts: { library?: string; roots?: string[] }): string[] {
  if (opts.library) return [expandHome(opts.library)];
  return (rootsOf(opts) ?? defaultRoots()).map(expandHome);
}

/**
 * An empty roots list means "none were given", not "search nowhere": Cli
 * always carries roots as an array, so without this every call site has to
 * repeat `roots.length ? roots : undefined` and one of them eventually
 * forgets -- turning a plain default-location lookup into an unexplained
 * library_not_found with an empty `searched`.
 */
function rootsOf(opts: { roots?: string[] }): string[] | undefined {
  return opts.roots !== undefined && opts.roots.length > 0 ? opts.roots : undefined;
}

export function discover(opts: {
  library?: string;
  roots?: string[];
}): LibraryInfo[] | SeratoError {
  if (opts.library) {
    const dir = expandHome(opts.library);
    let exists = false;
    try {
      exists = statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    const lib = exists ? detectLibrary(dir) : null;
    if (lib) return [lib];
    return err("library_not_found", `no Serato library at ${dir}`, { searched: [dir] });
  }

  const found: LibraryInfo[] = [];
  const searched = searchLocations(opts);
  for (const dir of searched) {
    const lib = detectLibrary(dir);
    if (lib) found.push(lib);
  }
  if (found.length === 0) return err("library_not_found", "no Serato library found", { searched });
  return found;
}

export type ResolvedLibrary = LibraryInfo & { masterPath: string };

/**
 * Picks the one library a tool should read, or says precisely why it cannot.
 *
 * Lives here rather than in the server so that every tool resolves its
 * library the same way. Early on it was inline in server.ts, which the tool
 * layer cannot import, so list_libraries resolved for itself while run_sql
 * was handed a finished path -- two answers to one question, and nine
 * further tools only multiplied them.
 *
 * The distinctions below are the whole reason this is not a one-liner:
 * found[0] can be a 3.x directory or an unreadable master.sqlite, and
 * opening either anyway surfaces a generic snapshot_failed instead of
 * naming the real problem.
 */
export function resolveLibrary(opts: {
  library?: string;
  roots?: string[];
}): ResolvedLibrary | SeratoError {
  const found = discover(opts);
  if (isSeratoError(found)) return found;

  const lib = found.find((l) => l.version === "4.x" && l.status === "ok");
  if (lib) return { ...lib, masterPath: join(lib.path, "master.sqlite") };

  const candidates = found.map((l) => ({ path: l.path, version: l.version, status: l.status }));
  const detected3x = found.find((l) => l.version === "3.x");
  // A 3.x-only result is not "not found": it needs a clear refusal naming
  // the detected version, not a code that reads as "look elsewhere" and
  // invites a retry against the same path.
  if (detected3x) {
    return err("unsupported_version", "found a Serato 3.x library; only 4.x is supported", {
      detected_version: detected3x.version,
      candidates,
    });
  }
  return err("library_not_found", "no readable Serato 4.x library found", {
    searched: searchLocations(opts),
    candidates,
  });
}
