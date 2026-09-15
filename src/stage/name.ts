import { err, type SeratoError } from "../errors.js";

/** Spec 4.2. Counted in characters (code points), not bytes or UTF-16 units:
 *  a DJ's crate named in Cyrillic must get the same budget as one in Latin. */
export const MAX_CRATE_NAME_LENGTH = 128;

/**
 * Validates and normalises a crate name before it goes anywhere near the
 * stage or root.sqlite.
 *
 * NFC first, because macOS hands out decomposed (NFD) strings and a model
 * types composed ones; "Café" from each would otherwise be two different
 * crates that look identical in Serato. The forbidden set is spec 4.2's:
 * "/" and ":" are path separators in the legacy Subcrates export Serato
 * writes from these names, NUL terminates strings in that format, and "%%"
 * is the separator Serato itself uses for nested crate file names.
 */
export function validateCrateName(raw: string): { name: string } | SeratoError {
  const name = raw.normalize("NFC").trim();
  if (name === "") {
    return err("invalid_crate_name", "a crate name cannot be empty", { reason: "empty" });
  }
  const length = [...name].length;
  if (length > MAX_CRATE_NAME_LENGTH) {
    return err(
      "invalid_crate_name",
      `a crate name is at most ${MAX_CRATE_NAME_LENGTH} characters, got ${length}`,
      { reason: "too_long", length, max: MAX_CRATE_NAME_LENGTH },
    );
  }
  for (const character of ["/", ":", "\u0000"]) {
    if (name.includes(character)) {
      return err("invalid_crate_name", "a crate name cannot contain / : or NUL", {
        reason: "forbidden_character",
        character: character === "\u0000" ? "NUL" : character,
      });
    }
  }
  if (name.includes("%%")) {
    return err("invalid_crate_name", "a crate name cannot contain %%", {
      reason: "forbidden_sequence",
      sequence: "%%",
    });
  }
  return { name };
}

/**
 * Whether two names collide the way container's UNIQUE(parent_id, name
 * COLLATE NOCASE, type) makes them collide. SQLite's NOCASE folds ASCII
 * only; comparing lowercased NFC strings is stricter for non-ASCII letters,
 * which is the safe direction -- a false "collision" refuses at staging, a
 * missed one fails the whole batch at apply.
 */
export function sameCrateName(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}
