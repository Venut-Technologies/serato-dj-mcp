import { describe, expect, it } from "vitest";
import { fromKeyText, fromKeyValue, KEY_COLUMNS, tonality } from "../../src/read/key.js";

describe("fromKeyValue", () => {
  // The two conversions below are both verified against Serato itself: they
  // anchor the wheel's orientation, which an off-by-one or a swapped A/B
  // side would silently rotate.
  it("matches the conversions verified against Serato", () => {
    expect(fromKeyValue(21)).toBe("10B");
    expect(fromKeyValue(1)).toBe("2A");
  });

  it("puts 0..11 on the minor side and 12..23 on the major side", () => {
    expect(fromKeyValue(0)).toBe("1A");
    expect(fromKeyValue(11)).toBe("12A");
    expect(fromKeyValue(12)).toBe("1B");
    expect(fromKeyValue(23)).toBe("12B");
  });

  // (-1 % 12) + 1 is 0 in both SQLite and JS -- a number that is not a
  // Camelot key but would be reported as one if the guard came after the
  // formula. -1 is what Serato writes for "not determined", so this is the
  // single most common value in the column.
  it("reports no key rather than 0A for the not-determined sentinel", () => {
    expect(fromKeyValue(-1)).toBeNull();
  });

  it("refuses values outside the wheel", () => {
    expect(fromKeyValue(24)).toBeNull();
    expect(fromKeyValue(1.5)).toBeNull();
  });
});

describe("fromKeyText", () => {
  // Verified on all 75 rows of the real library that carry Open Key text.
  // Serato's own parser returns -1 for these, which is why they have to be
  // read here at all.
  it("converts the Open Key values verified on the real library", () => {
    expect(fromKeyText("1m")).toEqual({ camelot: "8A", source: "open_key" });
    expect(fromKeyText("6m")).toEqual({ camelot: "1A", source: "open_key" });
    expect(fromKeyText("11m")).toEqual({ camelot: "6A", source: "open_key" });
    expect(fromKeyText("12d")).toEqual({ camelot: "7B", source: "open_key" });
  });

  // A rotation that still maps 1..12 onto 1..12 would pass the anchors above
  // only if it were the identity, but a mapping that collapsed two inputs
  // onto one output would not -- that is what this checks.
  it("maps the twelve Open Key numbers onto twelve distinct Camelot numbers", () => {
    const got = new Set<string>();
    for (let n = 1; n <= 12; n++) got.add(fromKeyText(`${n}m`)?.camelot ?? "");
    expect(got.size).toBe(12);
    expect(got.has("")).toBe(false);
  });

  it("refuses an Open Key number off the wheel", () => {
    expect(fromKeyText("13m")).toBeNull();
    expect(fromKeyText("0m")).toBeNull();
  });

  it("passes Camelot through, normalising its case", () => {
    expect(fromKeyText("9A")).toEqual({ camelot: "9A", source: "camelot" });
    expect(fromKeyText("12b")).toEqual({ camelot: "12B", source: "camelot" });
  });

  // "d" is Open Key for major, but D is also a note name. Both spellings
  // have to survive: 12d is 7B, D is 10B.
  it("does not confuse Open Key's major suffix with the note D", () => {
    expect(fromKeyText("12d")).toEqual({ camelot: "7B", source: "open_key" });
    expect(fromKeyText("D")).toEqual({ camelot: "10B", source: "musical" });
  });

  it("reads musical notation, including enharmonic spellings", () => {
    expect(fromKeyText("Am")).toEqual({ camelot: "8A", source: "musical" });
    expect(fromKeyText("Ebm")).toEqual({ camelot: "2A", source: "musical" });
    expect(fromKeyText("D#m")).toEqual({ camelot: "2A", source: "musical" });
    expect(fromKeyText("F#m")).toEqual({ camelot: "11A", source: "musical" });
    expect(fromKeyText("Gbm")).toEqual({ camelot: "11A", source: "musical" });
  });

  it("tolerates the spellings a tagger might write", () => {
    expect(fromKeyText("A min")?.camelot).toBe("8A");
    expect(fromKeyText("Aminor")?.camelot).toBe("8A");
    expect(fromKeyText("A maj")?.camelot).toBe("11B");
    expect(fromKeyText("A♭m")?.camelot).toBe("1A");
  });

  it("returns nothing for empty or unrecognised text", () => {
    expect(fromKeyText("")).toBeNull();
    expect(fromKeyText("   ")).toBeNull();
    expect(fromKeyText("H")).toBeNull();
    expect(fromKeyText("unknown")).toBeNull();
  });
});

describe("tonality", () => {
  it("prefers key_value, which is Serato's own parse", () => {
    // Contradictory on purpose: whichever column wins is visible in the
    // result, and key_value must.
    expect(tonality(21, "1m")).toEqual({ camelot: "10B", source: "key_value" });
  });

  // This is the case that covers 75 of 118 tracks: Serato could not parse
  // the typed key, stored -1, and left the text alone.
  it("falls back to the text when key_value says not determined", () => {
    expect(tonality(-1, "6m")).toEqual({ camelot: "1A", source: "open_key" });
  });

  it("reports nothing when neither column has an answer", () => {
    expect(tonality(-1, "")).toBeNull();
    expect(tonality(null, null)).toBeNull();
    expect(tonality(undefined, undefined)).toBeNull();
  });

  it("reads both columns, in the order the projection asks for them", () => {
    expect(KEY_COLUMNS).toEqual(["key_value", "key"]);
  });
});
