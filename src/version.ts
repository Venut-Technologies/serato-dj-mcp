import { readFileSync } from "node:fs";

/**
 * The one place this server learns its own version.
 *
 * Read from package.json rather than typed here, because a version typed in a
 * second place drifts: this repository shipped `0.1.0` in two source files
 * while the release process bumps only the manifest, and nothing would have
 * caught the two disagreeing. The release workflow checks the tag against
 * package.json, so package.json is the value the tag guarantees.
 *
 * Resolved through import.meta.url, one directory up from this module, never
 * relative to the working directory: the server runs under `npx` from
 * wherever the client happened to start it. package.json sits next to this
 * module's compiled location in both layouts -- `src/../package.json` in the
 * repository and `dist/../package.json` once installed -- and npm always
 * includes package.json in the tarball, whatever the `files` field lists.
 */
export const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
