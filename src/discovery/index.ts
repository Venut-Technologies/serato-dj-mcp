import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, type SeratoError } from "../errors.js";
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

export function discover(opts: {
  library?: string;
  roots?: string[];
}): LibraryInfo[] | SeratoError {
  const searched: string[] = [];

  if (opts.library) {
    const dir = expandHome(opts.library);
    searched.push(dir);
    let exists = false;
    try {
      exists = statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    const lib = exists ? detectLibrary(dir) : null;
    if (lib) return [lib];
    return err("library_not_found", `no Serato library at ${dir}`, { searched });
  }

  const found: LibraryInfo[] = [];
  for (const raw of opts.roots ?? defaultRoots()) {
    const dir = expandHome(raw);
    searched.push(dir);
    const lib = detectLibrary(dir);
    if (lib) found.push(lib);
  }
  if (found.length === 0) return err("library_not_found", "no Serato library found", { searched });
  return found;
}
