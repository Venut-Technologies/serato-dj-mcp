#!/usr/bin/env node
// Entry point of the Claude Desktop extension (MCP bundle) only; the npm
// package starts dist/index.js directly.
//
// A bundle's settings reach the server through mcp_config, which can
// substitute a value into an argument but cannot leave an argument out, so
// an off switch cannot be expressed as an absent --allow-writes. The bundle
// passes each switch as an environment variable instead, and this file turns
// the ones that are on into the same command-line flags a user of the npm
// package would type. The server itself is unchanged.

const on = (name) => process.env[name] === "true";

// An unset optional setting can arrive as the literal placeholder rather
// than as an empty string; neither is a path.
const library = process.env.SERATO_LIBRARY_PATH;
if (library === undefined || library === "" || library.startsWith("${user_config.")) {
  delete process.env.SERATO_LIBRARY_PATH;
}

const flags = [];
if (on("SERATO_DJ_MCP_BUNDLE_ALLOW_WRITES")) flags.push("--allow-writes");
if (on("SERATO_DJ_MCP_BUNDLE_ALLOW_RAW_SQL")) flags.push("--allow-raw-sql");
process.argv.splice(2, process.argv.length - 2, ...flags);

await import("./dist/index.js");
