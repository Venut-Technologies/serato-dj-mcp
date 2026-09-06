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
 * content carries a short summary; the payload rides in structuredContent
 * with a declared outputSchema.
 *
 * This is a trade, not a free win: a client without structured content
 * support sees the summary and loses the data. Accepted because the target
 * clients support it, and duplicating a 200-row page doubles the payload --
 * engine-dj-mcp puts the same object in both fields with two-space
 * indentation and declares no outputSchema at all.
 */
export function toCallToolResult(value: unknown): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
} {
  const isErr = isSeratoError(value);
  const obj = value as Record<string, unknown>;
  const text = isErr
    ? `${(obj.error as { code: string }).code}: ${(obj.error as { message: string }).message}`
    : summarise(obj);
  return { content: [{ type: "text", text }], structuredContent: obj, isError: isErr };
}
