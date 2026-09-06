import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Cli } from "./cli.js";
import { discover, searchLocations } from "./discovery/index.js";
import { toCallToolResult } from "./envelope.js";
import { err, isSeratoError } from "./errors.js";
import {
  listLibraries,
  listLibrariesDescription,
  listLibrariesOutput,
} from "./tools/list-libraries.js";
import { runSql, runSqlDescription, runSqlInput, runSqlOutput } from "./tools/run-sql.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

const names = new WeakMap<McpServer, string[]>();

/** Test seam: the SDK exposes no public registry, and asserting on which
 *  tools exist is the whole point of the gating tests. */
export function registeredToolNames(server: McpServer): string[] {
  return names.get(server) ?? [];
}

export function createServer(cli: Cli): McpServer {
  const server = new McpServer({ name: "serato-dj-mcp", version: "0.1.0" });
  const registered: string[] = [];
  names.set(server, registered);

  server.registerTool(
    "list_libraries",
    {
      title: "List Serato libraries",
      description: listLibrariesDescription,
      inputSchema: {},
      // outputSchema describes only the success payload. An error response
      // never has to fit it: toCallToolResult() (../envelope.ts) never puts
      // an error in structuredContent in the first place, so the MCP
      // client's structuredContent validator -- which validates against
      // this schema regardless of isError, contrary to its own comment --
      // never sees one. Verified 2026-09-06 with a real Client over
      // InMemoryTransport, calling listTools() (which builds that
      // validator) before callTool(): a success call round-trips validated,
      // and an error call round-trips as isError:true text with no
      // structuredContent, so the validator is never invoked for it.
      outputSchema: listLibrariesOutput.shape,
      annotations: RO,
    },
    async () => toCallToolResult(listLibraries({ library: cli.library, roots: cli.roots })),
  );
  registered.push("list_libraries");

  // Registered only when asked. A tool that exists and refuses still costs
  // context on every tools/list and still invites the model to try it.
  if (cli.allowRawSql) {
    server.registerTool(
      "run_sql",
      {
        title: "Run read-only SQL",
        description: runSqlDescription,
        inputSchema: runSqlInput.shape,
        // Success-only, same reasoning as list_libraries's outputSchema above.
        outputSchema: runSqlOutput.shape,
        annotations: RO,
      },
      async (args) => {
        const opts = { library: cli.library, roots: cli.roots.length ? cli.roots : undefined };
        const found = discover(opts);
        if (isSeratoError(found)) return toCallToolResult(found);
        const lib = found.find((l) => l.version === "4.x" && l.status === "ok");
        if (!lib) {
          // found[0] could be a 3.x directory or an unreadable master.sqlite;
          // opening it anyway would surface a generic snapshot_failed instead
          // of naming the real problem: no readable 4.x library exists here.
          const candidates = found.map((l) => ({
            path: l.path,
            version: l.version,
            status: l.status,
          }));
          const detected3x = found.find((l) => l.version === "3.x");
          // A 3.x-only result is not "not found": spec 6 and 12 promise a
          // clear refusal naming the detected version, not a code that reads
          // as "look elsewhere" and invites a retry against the same path.
          if (detected3x) {
            return toCallToolResult(
              err("unsupported_version", "found a Serato 3.x library; only 4.x is supported", {
                detected_version: detected3x.version,
                candidates,
              }),
            );
          }
          return toCallToolResult(
            err("library_not_found", "no readable Serato 4.x library found", {
              searched: searchLocations(opts),
              candidates,
            }),
          );
        }
        return toCallToolResult(
          await runSql(args, {
            livePath: join(lib.path, "master.sqlite"),
            cacheDir: cli.cacheDir,
          }),
        );
      },
    );
    registered.push("run_sql");
  }

  return server;
}
