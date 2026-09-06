import { z } from "zod";
import { isSeratoError } from "./errors.js";

export type Warning = { code: string; message: string; details?: Record<string, unknown> };

/** Shared shape for every tool's outputSchema: spec 4.0 puts warnings[] on
 *  every successful envelope, not just some of them. */
export const warningSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export function ok<T extends object>(
  payload: T,
  generation?: string,
  warnings?: Warning[],
): T & { generation?: string; warnings?: Warning[] } {
  // Declared as the return type directly (not Record<string, unknown>):
  // spreading a generic T does not carry an index signature, so TS 7's
  // stricter checker rejects assigning it to Record<string, unknown>.
  const out: T & { generation?: string; warnings?: Warning[] } = { ...payload };
  if (generation !== undefined) out.generation = generation;
  if (warnings !== undefined && warnings.length > 0) out.warnings = warnings;
  return out;
}

/** One-line description of a payload, for the text channel. */
function summarise(value: Record<string, unknown>): string {
  const bits: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (Array.isArray(v)) bits.push(`${k}: ${v.length}`);
    else if (k === "generation" || k === "next_cursor") bits.push(`${k} ${String(v)}`);
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    bits.push(`warnings: ${value.warnings.length}`);
  }
  return bits.length > 0 ? bits.join(", ") : "ok";
}

/**
 * content carries a short summary; a successful payload rides in
 * structuredContent with a declared outputSchema.
 *
 * This is a trade, not a free win: a client without structured content
 * support sees the summary and loses the data. Accepted because the target
 * clients support it, and duplicating a 200-row page doubles the payload --
 * engine-dj-mcp puts the same object in both fields with two-space
 * indentation and declares no outputSchema at all.
 *
 * An error value never rides in structuredContent, on either tool: the MCP
 * client validates whatever it finds there against the tool's outputSchema
 * without checking isError -- its own comment claims otherwise ("Only
 * validate structured content if present (not when there's an error)"), but
 * the actual condition only tests presence. A real client always calls
 * tools/list before calling a tool, which builds that validator (see
 * cacheToolMetadata in the SDK's client), so an error placed in
 * structuredContent is destroyed (MCP error -32602, "does not match the
 * tool's output schema") instead of delivered. The client's own guard --
 * `if (!result.structuredContent && !result.isError) throw ...` -- shows an
 * error result with no structuredContent is the shape it expects, not an
 * edge case. So the error rides as compact JSON in content instead, where
 * no schema ever touches it. Cost: the model reads it as JSON text rather
 * than as structured data.
 */
export function toCallToolResult(value: unknown):
  | {
      content: { type: "text"; text: string }[];
      structuredContent: Record<string, unknown>;
      isError: false;
    }
  | { content: { type: "text"; text: string }[]; isError: true } {
  if (isSeratoError(value)) {
    return { content: [{ type: "text", text: JSON.stringify(value) }], isError: true };
  }
  const obj = value as Record<string, unknown>;
  return {
    content: [{ type: "text", text: summarise(obj) }],
    structuredContent: obj,
    isError: false,
  };
}
