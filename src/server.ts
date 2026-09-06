import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Cli } from "./cli.js";
import { discover } from "./discovery/index.js";
import { toCallToolResult } from "./envelope.js";
import { isSeratoError } from "./errors.js";
import { listLibraries, listLibrariesDescription } from "./tools/list-libraries.js";
import { runSql, runSqlDescription, runSqlInput } from "./tools/run-sql.js";

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
        annotations: RO,
      },
      async (args) => {
        const found = discover({
          library: cli.library,
          roots: cli.roots.length ? cli.roots : undefined,
        });
        if (isSeratoError(found)) return toCallToolResult(found);
        const lib = found.find((l) => l.version === "4.x" && l.status === "ok") ?? found[0];
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
