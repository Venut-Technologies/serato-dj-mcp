import { describe, expect, it } from "vitest";
import { ERROR_CODES, err, isSeratoError } from "../src/errors.js";

describe("errors", () => {
  it("builds a structured error value, not an exception", () => {
    const e = err("library_not_found", "no library", { searched: ["/a", "/b"] });
    expect(e.error.code).toBe("library_not_found");
    expect(e.error.message).toBe("no library");
    expect(e.error.details).toEqual({ searched: ["/a", "/b"] });
  });

  it("omits details when not given", () => {
    expect(err("busy", "locked").error.details).toBeUndefined();
  });

  it("recognises its own errors and rejects look-alikes", () => {
    expect(isSeratoError(err("busy", "locked"))).toBe(true);
    expect(isSeratoError({ error: { code: "not_a_real_code", message: "x" } })).toBe(false);
    expect(isSeratoError({ error: "boom" })).toBe(false);
    expect(isSeratoError(null)).toBe(false);
    expect(isSeratoError({ tracks: [] })).toBe(false);
  });

  it("carries every code the P1 surface can raise", () => {
    for (const code of [
      "library_not_found",
      "unsupported_version",
      "serato_running",
      "permission_denied",
      "snapshot_failed",
      "invalid_argument",
      "busy",
    ] as const) {
      expect(ERROR_CODES).toHaveProperty(code);
    }
  });
});
