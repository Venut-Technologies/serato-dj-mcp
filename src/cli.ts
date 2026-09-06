import { homedir } from "node:os";
import { join } from "node:path";
import { err, type SeratoError } from "./errors.js";

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

  const needsValue = (i: number, flag: string): string | SeratoError =>
    i + 1 < argv.length ? argv[i + 1] : err("invalid_argument", `${flag} needs a value`);

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
        else if (a === "--cache-dir") cli.cacheDir = v;
        else cli.stateDir = v;
        break;
      }
      default:
        // Silently ignoring an unknown flag turns a typo of --allow-writes
        // into a read-only server with no diagnostic. Fail loudly instead.
        return err("invalid_argument", `unknown argument: ${a}`, { argument: a });
    }
  }
  return cli;
}
