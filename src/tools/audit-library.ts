import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import {
  CHECK_NAMES,
  type CheckResult,
  DEFAULT_CHECK_NAMES,
  FILESYSTEM_CHECKS,
  runChecks,
} from "../read/audit.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";

export const auditLibraryInput = z.object({
  checks: z.array(z.string()).min(1).max(CHECK_NAMES.length).optional(),
  /** Opt-in, because a stat against a disconnected volume blocks a
   *  synchronous server for seconds. See brokenPaths in ../read/audit.ts. */
  check_filesystem: z.boolean().optional(),
});

const checkSchema = z.object({
  name: z.string(),
  count: z.number(),
  sample_ids: z.array(z.number()).optional(),
  sample_groups: z.array(z.array(z.number())).optional(),
});

export const auditLibraryOutput = z.object({
  checks: z.array(checkSchema),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const auditLibraryDescription =
  `Diagnose the library. All checks run by default: ${DEFAULT_CHECK_NAMES.join(", ")}. ` +
  `${FILESYSTEM_CHECKS.join(", ")} reads Serato's own missing flag by default and ALSO walks the ` +
  "filesystem with check_filesystem: true -- opt-in because a stat against a disconnected drive " +
  "blocks for seconds. Each check reports a " +
  "count and up to 10 example track ids; duplicates reports groups instead, since which track " +
  "duplicates which is the actionable part. missing_key counts tracks with no key at all, " +
  "while key_unreadable_by_serato counts tracks whose key this server can read but Serato " +
  "itself cannot display.";

export async function auditLibrary(
  raw: unknown,
  ctx: ReadCtx,
): Promise<
  ({ checks: CheckResult[] } & { generation?: string; warnings?: Warning[] }) | SeratoError
> {
  const args = parseToolArgs(auditLibraryInput, raw);
  if (isSeratoError(args)) return args;

  const requested = args.checks ?? [...DEFAULT_CHECK_NAMES];
  const unknown = requested.filter((c) => !CHECK_NAMES.includes(c));
  if (unknown.length > 0) {
    return err("invalid_argument", `unknown check: ${unknown.join(", ")}`, {
      reason: "unknown_check",
      checks: unknown,
      allowed: CHECK_NAMES,
    });
  }

  return readSession(ctx, (handle) => {
    const warnings: Warning[] = schemaWarnings(handle);
    if (args.check_filesystem === true && !requested.some((c) => FILESYSTEM_CHECKS.includes(c))) {
      // The caller asked for a disk pass and named no check that has one.
      // Silently doing nothing is how the flag was a no-op before review
      // 2026-09-14 found it.
      warnings.push({
        code: "filesystem_check_not_selected",
        message: `check_filesystem has no effect unless one of ${FILESYSTEM_CHECKS.join(", ")} is selected`,
        details: { filesystem_checks: FILESYSTEM_CHECKS },
      });
    }
    const result = runChecks(requested, {
      db: handle.db,
      assetColumns: handle.schema.assetColumns,
      tables: handle.schema.tables,
      volumeRoots: handle.volumeRoots,
      checkFilesystem: args.check_filesystem === true,
      warnings,
    });
    return ok({ checks: result.checks }, handle.snapshot.generation, result.warnings);
  });
}
