import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { err, type SeratoError } from "./errors.js";
import { expandHome } from "./paths.js";

export type Cli = {
  library?: string;
  roots: string[];
  cacheDir: string;
  stateDir: string;
  allowWrites: boolean;
  allowRawSql: boolean;
};

/**
 * Snapshots may be lost freely; backups and manifests may not. macOS is
 * entitled to purge ~/Library/Caches, so the two live in separate trees.
 */
function defaultCacheDir(): string {
  return join(homedir(), "Library", "Caches", "serato-dj-mcp");
}
function defaultStateDir(): string {
  return join(homedir(), "Library", "Application Support", "serato-dj-mcp");
}

/**
 * On Windows both trees go under %LOCALAPPDATA%, where Serato keeps its own
 * library: a per-user folder that stays on this machine. %APPDATA% follows
 * the user to other machines in a domain, and neither a copy of the library
 * nor a backup of this machine's databases belongs on another one. `Cache`
 * and `State` keep the two apart for whoever cleans up by hand: the first
 * may be deleted, the second holds the backups. LOCALAPPDATA is set in every
 * interactive session, but an MCP client may start this process with an
 * environment of its own making, hence the fallback to where the variable
 * points by default.
 */
function windowsDataDir(env: NodeJS.ProcessEnv, kind: "Cache" | "State"): string {
  const local = env.LOCALAPPDATA || win32.join(homedir(), "AppData", "Local");
  return win32.join(local, "serato-dj-mcp", kind);
}

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Cli | { help: true } | { version: true } | SeratoError {
  const windows = platform === "win32";
  const home = { platform, home: homedir() };
  const cli: Cli = {
    roots: [],
    cacheDir: windows ? windowsDataDir(env, "Cache") : defaultCacheDir(),
    stateDir: windows ? windowsDataDir(env, "State") : defaultStateDir(),
    allowWrites: false,
    allowRawSql: false,
  };
  if (env.SERATO_LIBRARY_PATH) cli.library = env.SERATO_LIBRARY_PATH;

  // `reason` is mandatory for invalid_argument; every occurrence in
  // tools/run-sql.ts already carries one, and these two sites did not.
  const needsValue = (i: number, flag: string): string | SeratoError =>
    i + 1 < argv.length
      ? argv[i + 1]
      : err("invalid_argument", `${flag} needs a value`, { reason: "missing_value" });

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        return { help: true };
      case "--version":
      case "-V":
        return { version: true };
      case "--allow-writes":
        cli.allowWrites = true;
        break;
      case "--allow-raw-sql":
        cli.allowRawSql = true;
        break;
      case "--library":
      case "--root":
      case "--cache-dir":
      case "--state-dir": {
        const v = needsValue(i, a);
        if (typeof v !== "string") return v;
        i++;
        if (a === "--library") cli.library = v;
        else if (a === "--root") cli.roots.push(v);
        // --library and --root are expanded downstream in discovery/index.ts's
        // discover(), which every consumer of them goes through. --cache-dir
        // and --state-dir have no such downstream step, so a literal '~'
        // would otherwise reach mkdirSync() as-is and create a directory
        // named "~" inside the process's unpredictable CWD -- MCP clients
        // start this process via execve with no shell, so the tilde never
        // gets expanded on the way in. Measured 2026-09-06.
        else if (a === "--cache-dir") cli.cacheDir = expandHome(v, home);
        else cli.stateDir = expandHome(v, home);
        break;
      }
      default:
        // Silently ignoring an unknown flag turns a typo of --allow-writes
        // into a read-only server with no diagnostic. Fail loudly instead.
        return err("invalid_argument", `unknown argument: ${a}`, {
          argument: a,
          reason: "unknown_argument",
        });
    }
  }
  return cli;
}
