import { createHash } from "node:crypto";
import type { Warning } from "../envelope.js";
import { err, type SeratoError } from "../errors.js";
import type { CursorKey } from "./sort.js";

type CursorPayload = { fp: string; gen: string; key: CursorKey };

/** Stable JSON: object keys sorted at every depth, so the same filters in a
 *  different order fingerprint the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Identity of the query a cursor belongs to: every argument except the ones
 *  that legitimately change between pages (cursor and limit). */
export function fingerprint(args: unknown): string {
  return createHash("sha256").update(canonical(args)).digest("hex").slice(0, 16);
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * The cursor for the next page, or undefined when this page is the last.
 *
 * `lastRow` is the last row KEPT (not the extra one fetched to detect the
 * next page), and it carries the sort key the query computed: _null, _val,
 * _id. Both paginating track tools build it identically, which is why it is
 * one function rather than two copies.
 */
export function nextCursorFrom(
  hasMore: boolean,
  lastRow: Record<string, unknown> | undefined,
  fp: string,
  generation: string,
): string | undefined {
  if (!hasMore || lastRow === undefined) return undefined;
  const key: CursorKey = [
    Number(lastRow._null),
    lastRow._val as string | number | null,
    Number(lastRow._id),
  ];
  return encodeCursor({ fp, gen: generation, key });
}

/** Spec 4.3: 25 per track page, 200 for crates, 200 the ceiling everywhere. */
export const MAX_TRACK_LIMIT = 200;
export const DEFAULT_TRACK_LIMIT = 25;
export const MAX_CRATE_LIMIT = 200;
export const DEFAULT_CRATE_LIMIT = 200;

/**
 * Decodes a cursor and decides whether the caller may continue with it.
 *
 * A changed query is a refusal: continuing from a position that belongs to a
 * different result set returns rows that were never in this one. A changed
 * generation is only a warning (decision 4, 2026-09-07) -- the position is
 * still meaningful on the new snapshot because pagination is keyset, not
 * offset, and refusing would break the second page of every listing taken
 * while Serato is running.
 */
export function checkCursor(
  raw: string,
  fp: string,
  generation: string,
): { key: CursorKey; warnings: Warning[] } | SeratoError {
  const malformed = () =>
    err("invalid_argument", "cursor is not one this server issued", {
      reason: "cursor_malformed",
    });

  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    return malformed();
  }
  if (typeof payload !== "object" || payload === null) return malformed();
  if (typeof payload.fp !== "string" || typeof payload.gen !== "string") return malformed();
  const key = payload.key;
  if (
    !Array.isArray(key) ||
    key.length !== 3 ||
    typeof key[0] !== "number" ||
    typeof key[2] !== "number"
  ) {
    return malformed();
  }

  if (payload.fp !== fp) {
    return err("invalid_argument", "this cursor belongs to a different query", {
      reason: "cursor_query_mismatch",
    });
  }

  const warnings: Warning[] =
    payload.gen === generation
      ? []
      : [
          {
            code: "snapshot_advanced",
            message:
              "the library changed while paginating; continued from the same position on the new snapshot, so a few rows may be repeated or skipped",
            details: { cursor_generation: payload.gen, generation },
          },
        ];

  return { key, warnings };
}
