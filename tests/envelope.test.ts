import { describe, expect, it } from "vitest";
import { ok, toCallToolResult } from "../src/envelope.js";
import { err } from "../src/errors.js";

describe("envelope", () => {
  it("attaches generation and warnings only when given", () => {
    expect(ok({ a: 1 })).toEqual({ a: 1 });
    expect(ok({ a: 1 }, "abc123")).toEqual({ a: 1, generation: "abc123" });
    const w = [{ code: "schema_unknown", message: "user_version 999" }];
    expect(ok({ a: 1 }, "abc123", w)).toEqual({ a: 1, generation: "abc123", warnings: w });
  });

  // The full object rides in structuredContent; content carries a short
  // summary. This is a trade, not a free win: a client with no structured
  // content support sees only the summary. Accepted because the target
  // clients support it and a 200-row page would otherwise be sent twice.
  it("puts a summary in content and the object in structuredContent", () => {
    const r = toCallToolResult({ tracks: [1, 2, 3], generation: "abc123" });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ tracks: [1, 2, 3], generation: "abc123" });
    expect(r.content[0].text).toContain("tracks: 3");
    expect(r.content[0].text).toContain("abc123");
    expect(r.content[0].text.length).toBeLessThan(200);
  });

  it("flags an error value and still returns it structurally", () => {
    const r = toCallToolResult(err("busy", "locked", { retry_after_ms: 3000 }));
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { error: { code: string } }).error.code).toBe("busy");
    expect(r.content[0].text).toContain("busy");
  });
});
