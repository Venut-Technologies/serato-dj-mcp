import { homedir } from "node:os";

/** Expands a leading `~`. A model that copies a printed `~/...` back into an
 *  argument would otherwise hand us a path that does not exist. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/** Replaces the home prefix with `~` and nothing else. Applied to track paths
 *  before they reach the model; NOT applied to list_libraries.path, which the
 *  user needs to copy verbatim into --library. */
export function redactPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

const ROOT_DB = "/Library/Application Support/Serato/Library/root.sqlite";
const LOCATION_DB_SUFFIX = "/_Serato_/Library/location.sqlite";

/**
 * Measured 2026-09-03: location.path is SQL NULL in every observed row, so
 * the volume root comes only from connection.database_uri.
 *   .../Library/root.sqlite                              -> "/"
 *   /Volumes/X/_Serato_/Library/location.sqlite          -> "/Volumes/X"
 */
export function volumeRootFromDatabaseUri(uri: string): string {
  if (uri.endsWith(LOCATION_DB_SUFFIX)) return uri.slice(0, -LOCATION_DB_SUFFIX.length);
  if (uri.endsWith(ROOT_DB)) return "/";
  if (uri.endsWith("/root.sqlite")) return "/";
  throw new Error(`unrecognised database_uri: ${uri}`);
}

/** portable_id is relative to the volume root and carries no leading slash. */
export function portableIdToAbsolute(volumeRoot: string, portableId: string): string {
  const base = volumeRoot.endsWith("/") ? volumeRoot : `${volumeRoot}/`;
  return base + portableId;
}

export function isStreamingPortableId(portableId: string): boolean {
  return portableId.startsWith("streaming://");
}
