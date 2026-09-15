import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { sameCrateName, validateCrateName } from "../../src/stage/name.js";

const reason = (raw: string) => {
  const r = validateCrateName(raw);
  return isSeratoError(r) ? r.error.details?.reason : null;
};

describe("validateCrateName", () => {
  it("trims and returns the normalised name", () => {
    expect(validateCrateName("  Gigs 2026  ")).toEqual({ name: "Gigs 2026" });
  });

  // macOS hands out NFD; a model types NFC. Without normalisation the two
  // "Café" are different strings and Serato would show two crates that look
  // identical.
  it("normalises to NFC", () => {
    const nfd = "Cafe\u0301";
    const r = validateCrateName(nfd);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.name).toBe("Caf\u00e9");
    expect(r.name).toHaveLength(4);
  });

  it("refuses an empty name, including one that is only whitespace", () => {
    expect(reason("")).toBe("empty");
    expect(reason("   ")).toBe("empty");
  });

  it("refuses a name longer than 128 characters, counted as characters not bytes", () => {
    expect(reason("я".repeat(128))).toBeNull();
    expect(reason("я".repeat(129))).toBe("too_long");
  });

  it("refuses the characters and the sequence spec 4.2 forbids", () => {
    expect(reason("A/B")).toBe("forbidden_character");
    expect(reason("A:B")).toBe("forbidden_character");
    expect(reason("A\u0000B")).toBe("forbidden_character");
    expect(reason("100%% house")).toBe("forbidden_sequence");
    expect(reason("100% house")).toBeNull();
  });

  it("uses the invalid_crate_name code", () => {
    const r = validateCrateName("");
    expect(isSeratoError(r) && r.error.code).toBe("invalid_crate_name");
  });
});

describe("sameCrateName", () => {
  // The container UNIQUE constraint is name COLLATE NOCASE, so a staged name
  // that differs only by case collides at apply time; the stage has to see
  // the collision first.
  it("compares the way the container UNIQUE constraint does", () => {
    expect(sameCrateName("Gigs 2026", "gigs 2026")).toBe(true);
    expect(sameCrateName("Caf\u00e9", "CAFE\u0301")).toBe(true);
    expect(sameCrateName("Gigs", "Gigs 2026")).toBe(false);
  });
});
