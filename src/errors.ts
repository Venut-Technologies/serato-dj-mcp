/**
 * Closed taxonomy of error codes. Errors are returned as values, never
 * thrown across the tool boundary: a thrown ZodError surfaces to the model
 * as a protocol failure with no code, and the model cannot act on it.
 */
export const ERROR_CODES = {
  library_not_found: "library_not_found",
  unsupported_version: "unsupported_version",
  serato_running: "serato_running",
  permission_denied: "permission_denied",
  snapshot_failed: "snapshot_failed",
  invalid_argument: "invalid_argument",
  unknown_ids: "unknown_ids",
  generation_mismatch: "generation_mismatch",
  invalid_crate_name: "invalid_crate_name",
  crate_name_conflict: "crate_name_conflict",
  write_refused: "write_refused",
  write_failed_not_committed: "write_failed_not_committed",
  write_failed_committed_unverified: "write_failed_committed_unverified",
  busy: "busy",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export type SeratoError = {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
};

export function err(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): SeratoError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

export function isSeratoError(value: unknown): value is SeratoError {
  if (typeof value !== "object" || value === null) return false;
  const e = (value as { error?: unknown }).error;
  if (typeof e !== "object" || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so "toString"
  // would otherwise be accepted as a valid code and the taxonomy would no
  // longer be closed.
  return (
    typeof code === "string" && Object.hasOwn(ERROR_CODES, code) && typeof message === "string"
  );
}
