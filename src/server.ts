import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Cli } from "./cli.js";
import { toCallToolResult } from "./envelope.js";
import {
  auditLibrary,
  auditLibraryDescription,
  auditLibraryInput,
  auditLibraryOutput,
} from "./tools/audit-library.js";
import {
  getCrateTracks,
  getCrateTracksDescription,
  getCrateTracksInput,
  getCrateTracksOutput,
} from "./tools/get-crate-tracks.js";
import {
  getTracks,
  getTracksDescription,
  getTracksInput,
  getTracksOutput,
} from "./tools/get-tracks.js";
import {
  listCratesDescription,
  listCratesInput,
  listCratesOutput,
  listCratesTool,
} from "./tools/list-crates.js";
import {
  listLibraries,
  listLibrariesDescription,
  listLibrariesInput,
  listLibrariesOutput,
} from "./tools/list-libraries.js";
import { runSql, runSqlDescription, runSqlInput, runSqlOutput } from "./tools/run-sql.js";
import {
  searchTracks,
  searchTracksDescription,
  searchTracksInput,
  searchTracksOutput,
} from "./tools/search-tracks.js";

const VERSION = "0.1.0";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

const names = new WeakMap<Server, string[]>();

/** Test seam: there is no public registry to read, and asserting on which
 *  tools exist is the whole point of the gating tests. */
export function registeredToolNames(server: Server): string[] {
  return names.get(server) ?? [];
}

type Entry = { descriptor: Tool; call: (raw: unknown) => Promise<CallToolResult> };

/**
 * Describes one tool for tools/list.
 *
 * The advertised JSON Schema is generated from the very zod schema the tool
 * parses with, so the two cannot drift; draft-7 is chosen to keep the wire
 * bytes identical to what the SDK's own conversion produced before this
 * server took the handlers over (verified 2026-09-06 by diffing the
 * advertised schema for run_sql against the previous build's).
 */
function describeTool(
  name: string,
  title: string,
  description: string,
  input: z.ZodType,
  output: z.ZodType,
): Tool {
  return {
    name,
    title,
    description,
    inputSchema: z.toJSONSchema(input, { target: "draft-7", io: "input" }) as Tool["inputSchema"],
    outputSchema: z.toJSONSchema(output, {
      target: "draft-7",
      io: "output",
    }) as Tool["outputSchema"],
    annotations: RO,
  };
}

/**
 * Serves tools/list and tools/call directly on the low-level Server rather
 * than through McpServer.registerTool.
 *
 * The reason is argument errors. McpServer parses `arguments` against the
 * tool's inputSchema *before* the handler runs and, on failure, answers with
 * its own prose -- measured 2026-09-06: "MCP error -32602: Input validation
 * error: Invalid arguments for tool run_sql: Too big: expected number to be
 * <=500 at limit". That message carries no `error.code`, so a malformed
 * argument reached the model in a shape nothing else in this server uses,
 * and no helper of ours could ever see it: exactly the defect spec 6 names
 * when it asks for one argument-parsing helper across all tools. Owning the
 * dispatch is what lets parseToolArgs (../args.ts) be that helper.
 *
 * Everything McpServer did for us that this server actually uses is a dozen
 * lines: a name -> descriptor listing, a name lookup, and a call. The rest
 * (task augmentation, enable/disable, listChanged) is unused, and its output
 * validation is something this server is better off without -- it is what
 * destroyed every error response in the outputSchema defect fixed in 62cbab3.
 */
export function createServer(cli: Cli): Server {
  const server = new Server(
    { name: "serato-dj-mcp", version: VERSION },
    { capabilities: { tools: {} } },
  );

  const entries: Entry[] = [
    {
      descriptor: describeTool(
        "list_libraries",
        "List Serato libraries",
        listLibrariesDescription,
        listLibrariesInput,
        listLibrariesOutput,
      ),
      call: async (raw) =>
        toCallToolResult(listLibraries(raw, { library: cli.library, roots: cli.roots })),
    },
    {
      descriptor: describeTool(
        "list_crates",
        "List Serato crates",
        listCratesDescription,
        listCratesInput,
        listCratesOutput,
      ),
      call: async (raw) =>
        toCallToolResult(
          await listCratesTool(raw, {
            library: cli.library,
            roots: cli.roots,
            cacheDir: cli.cacheDir,
          }),
        ),
    },
    {
      descriptor: describeTool(
        "search_tracks",
        "Search Serato tracks",
        searchTracksDescription,
        searchTracksInput,
        searchTracksOutput,
      ),
      call: async (raw) =>
        toCallToolResult(
          await searchTracks(raw, {
            library: cli.library,
            roots: cli.roots,
            cacheDir: cli.cacheDir,
          }),
        ),
    },
    {
      descriptor: describeTool(
        "get_tracks",
        "Get Serato tracks by id",
        getTracksDescription,
        getTracksInput,
        getTracksOutput,
      ),
      call: async (raw) =>
        toCallToolResult(
          await getTracks(raw, { library: cli.library, roots: cli.roots, cacheDir: cli.cacheDir }),
        ),
    },
    {
      descriptor: describeTool(
        "get_crate_tracks",
        "Get the tracks of a crate",
        getCrateTracksDescription,
        getCrateTracksInput,
        getCrateTracksOutput,
      ),
      call: async (raw) =>
        toCallToolResult(
          await getCrateTracks(raw, {
            library: cli.library,
            roots: cli.roots,
            cacheDir: cli.cacheDir,
          }),
        ),
    },
    {
      descriptor: describeTool(
        "audit_library",
        "Audit the Serato library",
        auditLibraryDescription,
        auditLibraryInput,
        auditLibraryOutput,
      ),
      call: async (raw) =>
        toCallToolResult(
          await auditLibrary(raw, {
            library: cli.library,
            roots: cli.roots,
            cacheDir: cli.cacheDir,
          }),
        ),
    },
  ];

  // Registered only when asked. A tool that exists and refuses still costs
  // context on every tools/list and still invites the model to try it.
  if (cli.allowRawSql) {
    entries.push({
      descriptor: describeTool(
        "run_sql",
        "Run read-only SQL",
        runSqlDescription,
        runSqlInput,
        runSqlOutput,
      ),
      call: async (raw) =>
        toCallToolResult(
          await runSql(raw, { library: cli.library, roots: cli.roots, cacheDir: cli.cacheDir }),
        ),
    });
  }

  names.set(
    server,
    entries.map((e) => e.descriptor.name),
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: entries.map((e) => e.descriptor),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const entry = entries.find((e) => e.descriptor.name === request.params.name);
    if (!entry) {
      // Deliberately not an `invalid_argument` value: that taxonomy is about
      // the library and its contents, and a name that was never advertised
      // is a protocol-level mistake by the caller. Shape and wording follow
      // what McpServer did for the same case, so clients see no change.
      return {
        content: [{ type: "text", text: `Tool ${request.params.name} not found` }],
        isError: true,
      };
    }
    return entry.call(request.params.arguments);
  });

  return server;
}
