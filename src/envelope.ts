import { z } from "zod";
import { isSeratoError } from "./errors.js";

export type Warning = { code: string; message: string; details?: Record<string, unknown> };

/** Shared shape for every tool's outputSchema: warnings[] belongs on every
 *  successful envelope, not just some of them. */
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

/**
 * A successful payload rides twice: in structuredContent, against the
 * declared outputSchema, and as compact JSON text in content.
 *
 * content used to carry only a one-line summary ("crates: 3"), on the
 * assumption that the target clients read structuredContent. Claude Desktop
 * does not: measured 2026-09-24 on Claude Desktop 2.7032.0, list_crates
 * reached the model as "crates: 3, generation ..." with no crate in it,
 * while Claude Code, on the same server, received every row. The MCP
 * specification asks for exactly this duplication -- a tool returning
 * structured content SHOULD also return it serialised in a text block --
 * and the cost, a page sent twice, is paid in compact JSON, without the
 * indentation engine-dj-mcp spends on it.
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
 * edge case. So the error rides as compact JSON in content only, where
 * no schema ever touches it.
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
    content: [{ type: "text", text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}
