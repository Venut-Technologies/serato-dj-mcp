/**
 * Tonality, as Camelot.
 *
 * Serato stores it twice and neither column alone is enough. Measured
 * 2026-09-06 across 118 real tracks:
 *
 *   key_value only ............ 39 of 118
 *   key_value or text `key` ... 114 of 118
 *
 * The gap is Open Key notation (`6m`, `12d`), which Serato's own
 * serato_raw_key_string_to_key_type() does not recognise: it stores -1 in
 * key_value and leaves the typed text alone. Harmonic matching is one of the
 * two leading scenarios for this server, so reading key_value alone would
 * run it on a third of the library.
 *
 * These rules decide the contents of the snapshot's derived mcp_key table,
 * and that table is reused across runs by a name that carries
 * DERIVED_VERSION (snapshot/derive.ts). **Change anything here that changes
 * what tonality() returns, and DERIVED_VERSION has to be bumped in the same
 * commit** -- otherwise a cached snapshot keeps serving keys computed by the
 * old rules. The golden test in tests/snapshot-derive.test.ts is what makes
 * forgetting it fail loudly rather than silently.
 */

/** Both columns are read, in this order. key_value is authoritative when
 *  set; the text is a fallback, not a cross-check. Consumed by
 *  snapshot/derive.ts, which builds the snapshot's mcp_key table from them. */
export const KEY_COLUMNS = ["key_value", "key"] as const;

export type KeySource = "key_value" | "open_key" | "camelot" | "musical";

export type Tonality = { camelot: string; source: KeySource };

/**
 * The Camelot wheel, in key_value order: index 0..11 are the minor keys
 * (Camelot 1A..12A), 12..23 the majors (1B..12B).
 *
 * One table, not two: the musical names below and Serato's integer
 * key_value index the same wheel, so deriving both from one array is what
 * keeps them from drifting apart. Verified against two known conversions --
 * D -> 21 -> 10B and Ebm -> 1 -> 2A.
 *
 * Separately, cross-checked against Serato itself on 2026-09-06: of the 39
 * real tracks carrying both a key_value and a text key, fromKeyValue() and
 * fromKeyText() agreed on all 39, across 14 distinct spellings (Abm, Am,
 * Bbm, Bm, Cm, D, E, Ebm, Em, F, F#m, Fm, Gm, and the Camelot passthrough
 * 9A).
 */
const MINOR = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "Dbm"];
const MAJOR = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"];

/** Enharmonic spellings, all pointing at the name used in the wheel above. */
const ALIASES: Record<string, string> = {
  "g#m": "abm",
  "d#m": "ebm",
  "a#m": "bbm",
  gbm: "f#m",
  "c#m": "dbm",
  gb: "f#",
  "c#": "db",
  "g#": "ab",
  "d#": "eb",
  "a#": "bb",
};

const BY_NAME = new Map<string, string>();
for (const [i, name] of MINOR.entries()) BY_NAME.set(name.toLowerCase(), `${i + 1}A`);
for (const [i, name] of MAJOR.entries()) BY_NAME.set(name.toLowerCase(), `${i + 1}B`);

/**
 * key_value -> Camelot.
 *
 * The negative guard comes before the formula, not after: (-1 % 12) + 1 is 0
 * in both SQLite and JS, which is not a Camelot number and would be reported
 * as if it were a real key.
 */
export function fromKeyValue(keyValue: number): string | null {
  if (!Number.isInteger(keyValue) || keyValue < 0 || keyValue > 23) return null;
  return `${(keyValue % 12) + 1}${keyValue < 12 ? "A" : "B"}`;
}

/**
 * Text `key` -> Camelot, recognising the three notations a Serato library
 * actually holds: Open Key (`6m`), Camelot (`9A`), and musical (`Am`, `Bbm`,
 * `D`).
 *
 * Open Key and Camelot cannot be confused with each other -- one is suffixed
 * m/d, the other A/B -- but "d" is also a musical note name, so the Open Key
 * branch requires a leading number and is tried first.
 */
export function fromKeyText(text: string): Tonality | null {
  const t = text
    .trim()
    .toLowerCase()
    .replaceAll("♭", "b")
    .replaceAll("♯", "#")
    .replaceAll(/[\s_-]/g, "");
  if (t === "") return null;

  const openKey = /^(\d{1,2})([md])$/.exec(t);
  if (openKey) {
    const n = Number(openKey[1]);
    if (n < 1 || n > 12) return null;
    // Verified on all 75 rows that carry it: 1m -> 8A, 6m -> 1A, 11m -> 6A,
    // 12d -> 7B.
    return {
      camelot: `${((n + 6) % 12) + 1}${openKey[2] === "m" ? "A" : "B"}`,
      source: "open_key",
    };
  }

  const camelot = /^(\d{1,2})([ab])$/.exec(t);
  if (camelot) {
    const n = Number(camelot[1]);
    if (n < 1 || n > 12) return null;
    return { camelot: `${n}${camelot[2].toUpperCase()}`, source: "camelot" };
  }

  // "Amin"/"A minor"/"Amaj" all reduce to the wheel's own spelling before
  // the lookup; a bare note name is major, as it is everywhere else.
  const musical = t.replace(/(minor|min)$/, "m").replace(/(major|maj)$/, "");
  const name = ALIASES[musical] ?? musical;
  const hit = BY_NAME.get(name);
  return hit === undefined ? null : { camelot: hit, source: "musical" };
}

/**
 * The layered rule: key_value when it is set, then the text, then nothing.
 *
 * `source` travels with the answer because the two are not equally
 * trustworthy -- key_value is Serato's own parse, the text is ours -- and a
 * model choosing the next track deserves to know which it got.
 */
export function tonality(keyValue: unknown, keyText: unknown): Tonality | null {
  if (typeof keyValue === "number") {
    const camelot = fromKeyValue(keyValue);
    if (camelot !== null) return { camelot, source: "key_value" };
  }
  if (typeof keyText === "string") return fromKeyText(keyText);
  return null;
}
