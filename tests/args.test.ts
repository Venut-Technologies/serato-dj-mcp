import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseToolArgs } from "../src/args.js";
import { isSeratoError } from "../src/errors.js";

const schema = z.object({
  sql: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
});

describe("parseToolArgs", () => {
  it("returns the parsed value on success", () => {
    expect(parseToolArgs(schema, { sql: "SELECT 1", limit: 5 })).toEqual({
      sql: "SELECT 1",
      limit: 5,
    });
  });

  it("treats missing arguments as an empty object", () => {
    // `arguments` is optional in the MCP call request, so a no-argument tool
    // is called with undefined. That must reach the schema as {} and be
    // accepted, not crash and not be reported as a violation.
    expect(parseToolArgs(z.object({}), undefined)).toEqual({});
  });

  it("returns invalid_argument, not a throw, for a violation", () => {
    const r = parseToolArgs(schema, { sql: "SELECT 1", limit: 1000 });
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.code).toBe("invalid_argument");
    // `reason` is mandatory for every invalid_argument.
    expect(r.error.details?.reason).toBe("schema_violation");
    expect(r.error.details?.issues).toEqual([
      expect.objectContaining({ path: "limit", code: "too_big" }),
    ]);
    // The message has to name the offending field: the model's next move is
    // to fix that argument, and an issue list alone reads as opaque.
    expect(r.error.message).toContain("limit");
  });

  it("reports every failing field, not just the first", () => {
    const r = parseToolArgs(schema, { sql: "", limit: 0 });
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    const issues = r.error.details?.issues as { path: string }[];
    expect(issues.map((i) => i.path).sort()).toEqual(["limit", "sql"]);
  });

  it("lets a cross-field check name its own reason", () => {
    // This is how cross-field refusals work -- `around` together with
    // `min`/`max`, `crate.id` together with `crate.name`, a cursor that does
    // not match its query -- get a specific reason without a second error
    // path. Written here early, before any tool needed it, so the mechanism
    // would already exist when one did.
    const cursorSchema = z
      .object({ query: z.string().optional(), cursor: z.string().optional() })
      .refine((v) => !(v.cursor !== undefined && v.query !== undefined), {
        error: "cursor cannot be combined with query",
        params: { reason: "cursor_query_mismatch" },
      });

    const r = parseToolArgs(cursorSchema, { query: "a", cursor: "b" });
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.details?.reason).toBe("cursor_query_mismatch");
    expect(r.error.message).toContain("cursor cannot be combined with query");
  });

  it("falls back to schema_violation when a custom issue names no reason", () => {
    const refined = z.object({ n: z.number() }).refine((v) => v.n > 0, { error: "must be > 0" });
    const r = parseToolArgs(refined, { n: -1 });
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.details?.reason).toBe("schema_violation");
  });

  it("reports a root-level violation without a stray path prefix", () => {
    const r = parseToolArgs(schema, "not an object");
    expect(isSeratoError(r)).toBe(true);
    if (!isSeratoError(r)) return;
    expect(r.error.message).not.toMatch(/^:/);
    expect(r.error.details).toBeDefined();
    if (r.error.details === undefined) return;
    expect((r.error.details.issues as { path: string }[])[0].path).toBe("");
  });
});
