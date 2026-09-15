#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "./cli.js";
import { isSeratoError } from "./errors.js";
import { createServer } from "./server.js";

const VERSION = "0.1.0";

export const HELP = `serato-dj-mcp ${VERSION} -- MCP server for the Serato DJ 4.x library

Usage: serato-dj-mcp [options]

  --library <path>     Path to the Serato Library directory (the one holding master.sqlite)
  --root <dir>         Extra directory to search; may be repeated
  --cache-dir <dir>    Where snapshots go (safe to delete)
  --state-dir <dir>    Where backups and manifests go (NOT safe to delete)
  --allow-raw-sql      Register run_sql
  --allow-writes       Register stage_crate, preview_changes, apply_changes, discard_changes
  -h, --help           Show this help
  -V, --version        Show the version

Environment:
  SERATO_LIBRARY_PATH  Same as --library; --library wins.
`;

const parsed = parseArgs(process.argv.slice(2), process.env);

if (isSeratoError(parsed)) {
  process.stderr.write(`${parsed.error.code}: ${parsed.error.message}\n\n${HELP}`);
  process.exit(2);
}
if ("help" in parsed) {
  process.stdout.write(HELP);
  process.exit(0);
}
if ("version" in parsed) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// Everything diagnostic goes to stderr: stdout carries the MCP protocol.
process.stderr.write(
  `serato-dj-mcp ${VERSION} on stdio (read-only${parsed.allowRawSql ? ", raw sql enabled" : ""})\n`,
);

await createServer(parsed).connect(new StdioServerTransport());
