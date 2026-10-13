import { homedir } from "node:os";
import { win32 } from "node:path";

/**
 * The two facts about the host that decide how a home-relative path is read.
 * Passed in rather than read inside each function so that the Windows rules
 * are tested on macOS and Linux, and the POSIX rules on Windows.
 */
export type PathEnv = { platform: NodeJS.Platform; home: string };

const hostEnv = (): PathEnv => ({ platform: process.platform, home: homedir() });

/** Expands a leading `~`. A model that copies a printed `~/...` back into an
 *  argument would otherwise hand us a path that does not exist. */
export function expandHome(p: string, env: PathEnv = hostEnv()): string {
  if (p === "~") return env.home;
  if (env.platform === "win32") {
    // Both separators: redactPath below prints `~\...` for a Windows path,
    // and a config file written by hand usually says `~/...`. On POSIX a
    // backslash is an ordinary filename character, so `~\x` is left alone
    // there.
    if (p.startsWith("~/") || p.startsWith("~\\")) return win32.join(env.home, p.slice(2));
    return p;
  }
  if (p.startsWith("~/")) return env.home + p.slice(1);
  return p;
}

/** Replaces the home prefix with `~` and nothing else. Applied to track paths
 *  before they reach the model; NOT applied to list_libraries.path, which the
 *  user needs to copy verbatim into --library. */
export function redactPath(p: string, env: PathEnv = hostEnv()): string {
  const home = env.home;
  if (env.platform === "win32") {
    // Windows paths compare without regard to case and take either
    // separator, so `c:\users\v\Music` is under `C:\Users\v` too. Lower-casing
    // is not NTFS's exact folding table; a miss only leaves a path unredacted
    // that an exact comparison would have left unredacted as well.
    const next = p.charAt(home.length);
    const under = next === "" || next === "\\" || next === "/";
    return under && p.slice(0, home.length).toLowerCase() === home.toLowerCase()
      ? `~${p.slice(home.length)}`
      : p;
  }
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

const LOCATION_DB_SUFFIX = "/_Serato_/Library/location.sqlite";
const WINDOWS_LOCATION_DB_SUFFIX = "\\_Serato_\\Library\\location.sqlite";

/** `D:\...` or `D:/...`. No absolute POSIX path starts this way, so testing
 *  for it first leaves every POSIX uri on the code path it always had. */
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/** `\\server\share\...`, for a store on a network share. */
const WINDOWS_UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]/;

/** A volume root this module produced from a Windows uri: `D:\`, `D:\sub`
 *  or `\\server\share`. */
function isWindowsRoot(volumeRoot: string): boolean {
  return /^[A-Za-z]:\\/.test(volumeRoot) || volumeRoot.startsWith("\\\\");
}

/**
 * Measured 2026-09-03: location.path is SQL NULL in every observed row, so
 * the volume root comes only from connection.database_uri. The store's kind
 * is carried by its filename: location.sqlite names a volume store (root is
 * the path before /_Serato_/Library/), and root.sqlite names the boot-disk
 * store (root is always /).
 *   /Users/v/Library/Application Support/Serato/Library/root.sqlite     -> "/"
 *   /Volumes/EXTDISK/_Serato_/Library/location.sqlite                   -> "/Volumes/EXTDISK"
 *
 * The Windows forms below are an ASSUMPTION, not a measurement: no
 * master.sqlite written by Serato on Windows has been examined, so what it
 * puts in database_uri there is unknown. They assume a plain path with a
 * drive letter (or a \\server\share prefix) and either separator:
 *   D:\_Serato_\Library\location.sqlite                                 -> "D:\"
 *   D:/_Serato_/Library/location.sqlite                                 -> "D:\"
 *   C:\Users\v\AppData\Local\Serato\Library\root.sqlite                 -> "C:\"
 *   \\nas\music\_Serato_\Library\location.sqlite                        -> "\\nas\music"
 * What was measured, on 2026-10-12 in a location.sqlite that Serato created
 * on a Windows drive (schema 202): asset.portable_id is relative to the
 * drive's root, with forward slashes and no leading slash. A drive root is
 * returned as `D:\` and never as `D:`, which Windows reads as "the current
 * directory on D:". Any other Windows path -- another filename, a root.sqlite
 * on a network share -- is unrecognised, and the caller reports that
 * location's root as unknown rather than guessing one.
 */
export function volumeRootFromDatabaseUri(uri: string): string {
  if (WINDOWS_DRIVE_PATH.test(uri) || WINDOWS_UNC_PATH.test(uri)) {
    const path = uri.replaceAll("/", "\\");
    if (path.endsWith(WINDOWS_LOCATION_DB_SUFFIX)) {
      const root = path.slice(0, -WINDOWS_LOCATION_DB_SUFFIX.length);
      return /^[A-Za-z]:$/.test(root) ? `${root}\\` : root;
    }
    if (WINDOWS_DRIVE_PATH.test(uri) && path.endsWith("\\root.sqlite")) {
      return `${path.slice(0, 2)}\\`;
    }
    throw new Error(`unrecognised database_uri: ${uri}`);
  }
  if (uri.endsWith(LOCATION_DB_SUFFIX)) return uri.slice(0, -LOCATION_DB_SUFFIX.length);
  if (uri.endsWith("/root.sqlite")) return "/";
  throw new Error(`unrecognised database_uri: ${uri}`);
}

/**
 * Whether a database_uri names the boot disk's own store, root.sqlite, in
 * either the measured POSIX form or the assumed Windows one. Case is
 * ignored because this replaces a SQL `LIKE '%/root.sqlite'`, which ignores
 * it for ASCII: the POSIX answer is the one that query gave.
 */
export function isRootStoreUri(uri: string): boolean {
  const lower = uri.toLowerCase();
  return lower.endsWith("/root.sqlite") || lower.endsWith("\\root.sqlite");
}

/**
 * portable_id is relative to the volume root and carries no leading slash.
 * It uses forward slashes on Windows as well (measured 2026-10-12, see
 * above); under a Windows root they become backslashes, so the result is one
 * consistent path that redactPath can compare with the home directory.
 */
export function portableIdToAbsolute(volumeRoot: string, portableId: string): string {
  if (isWindowsRoot(volumeRoot)) {
    const base = volumeRoot.endsWith("\\") ? volumeRoot : `${volumeRoot}\\`;
    return base + portableId.replaceAll("/", "\\");
  }
  const base = volumeRoot.endsWith("/") ? volumeRoot : `${volumeRoot}/`;
  return base + portableId;
}

export function isStreamingPortableId(portableId: string): boolean {
  return portableId.startsWith("streaming://");
}
