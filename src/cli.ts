import { homedir } from "node:os";
import { join } from "node:path";
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

export function parseArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Cli | { help: true } | { version: true } | SeratoError {
  const cli: Cli = {
    roots: [],
    cacheDir: defaultCacheDir(),
    stateDir: defaultStateDir(),
    allowWrites: false,
    allowRawSql: false,
  };
  if (env.SERATO_LIBRARY_PATH) cli.library = env.SERATO_LIBRARY_PATH;

  // Spec 6 makes `reason` mandatory for invalid_argument; every occurrence
  // in tools/run-sql.ts already carries one, and these two sites did not.
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
        // named "~" inside the process's unpredictable CWD (spec 3.2) --
        // MCP clients start this process via execve with no shell, so the
        // tilde never gets expanded on the way in. Measured 2026-09-06.
        else if (a === "--cache-dir") cli.cacheDir = expandHome(v);
        else cli.stateDir = expandHome(v);
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
