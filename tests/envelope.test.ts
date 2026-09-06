import { describe, expect, it } from "vitest";
import { ok, toCallToolResult } from "../src/envelope.js";
import { err } from "../src/errors.js";

describe("envelope", () => {
  // vitest's toEqual ignores keys whose value is `undefined`, so it alone
  // cannot prove a key is *absent*: an implementation that unconditionally
  // set `out.generation = generation` (leaving `generation: undefined`)
  // would still satisfy `toEqual({ a: 1 })`. Object.hasOwn checks presence
  // directly instead.
  it("attaches generation and warnings only when given", () => {
    const bare = ok({ a: 1 });
    expect(bare).toEqual({ a: 1 });
    expect(Object.hasOwn(bare, "generation")).toBe(false);
    expect(Object.hasOwn(bare, "warnings")).toBe(false);

    const withGeneration = ok({ a: 1 }, "abc123");
    expect(withGeneration).toEqual({ a: 1, generation: "abc123" });
    expect(Object.hasOwn(withGeneration, "warnings")).toBe(false);

    const w = [{ code: "schema_unknown", message: "user_version 999" }];
    expect(ok({ a: 1 }, "abc123", w)).toEqual({ a: 1, generation: "abc123", warnings: w });

    // An empty warnings array is a value, not undefined, so toEqual would
    // not catch a regression that dropped the `warnings.length > 0` guard
    // and attached `warnings: []`. Assert the omission directly.
    const withEmptyWarnings = ok({ a: 1 }, "abc123", []);
    expect(Object.hasOwn(withEmptyWarnings, "warnings")).toBe(false);
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

  // An error must NOT ride in structuredContent: the MCP client validates
  // whatever it finds there against the tool's outputSchema regardless of
  // isError (see the comment on toCallToolResult), so an error placed there
  // is destroyed rather than delivered. It travels as compact JSON in
  // content instead, where no schema ever touches it.
  it("flags an error value and carries it as JSON text, not structuredContent", () => {
    const value = err("busy", "locked", { retry_after_ms: 3000 });
    const r = toCallToolResult(value);
    expect(r.isError).toBe(true);
    expect(Object.hasOwn(r, "structuredContent")).toBe(false);
    expect(JSON.parse(r.content[0].text)).toEqual(value);
  });
});
