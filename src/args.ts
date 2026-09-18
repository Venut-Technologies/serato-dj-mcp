import type { z } from "zod";
import { err, type SeratoError } from "./errors.js";

type Issue = { path: string; code: string; message: string };

/**
 * The single place raw tool arguments become typed ones, deliberately the
 * only one: engine-dj-mcp's defect was that some tools called .parse() and
 * others safeParse(), so one class of problem -- a malformed argument --
 * reached the model in two different shapes.
 *
 * Every failure comes back as an `invalid_argument` value carrying the
 * mandatory `reason`, never as a throw: a thrown ZodError is converted by
 * the MCP layer into prose with no code at all (measured 2026-09-06:
 * `{"sql":"","limit":1000}` came back as isError text reading "MCP error
 * -32602: Input validation error: Invalid arguments for tool run_sql: Too
 * small ..."), which the model cannot dispatch on and which contradicts the
 * taxonomy in errors.ts.
 *
 * `reason` defaults to "schema_violation" but a check can name its own by
 * passing `params: { reason: "..." }` to .refine()/.superRefine(). That is
 * how this server's cross-field refusals -- `around` together with
 * `min`/`max`, `crate.id` together with `crate.name`, a cursor that does not
 * match its query -- get their specific reason without a second error path:
 * they are refinements on the tool's own schema, and they land here like any
 * other issue.
 */
export function parseToolArgs<T extends z.ZodType>(
  schema: T,
  raw: unknown,
): z.output<T> | SeratoError {
  // `arguments` is optional in the MCP call request, so a no-argument tool
  // is called with undefined rather than {}.
  const result = schema.safeParse(raw === undefined ? {} : raw);
  if (result.success) return result.data;

  const issues: Issue[] = result.error.issues.map((i) => ({
    path: i.path.map(String).join("."),
    code: i.code,
    message: i.message,
  }));
  const message = issues
    .map((i) => (i.path === "" ? i.message : `${i.path}: ${i.message}`))
    .join("; ");
  return err("invalid_argument", message, { reason: reasonOf(result.error), issues });
}

function reasonOf(error: z.ZodError): string {
  for (const issue of error.issues) {
    // Only custom issues (.refine/.superRefine) can carry params; zod's
    // built-in issues never do, so this never fires for a plain type error.
    const params = (issue as { params?: Record<string, unknown> }).params;
    if (params !== undefined && typeof params.reason === "string") return params.reason;
  }
  return "schema_violation";
}
