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
  `Diagnose the library. Runs ${DEFAULT_CHECK_NAMES.join(", ")} by default; ` +
  `${FILESYSTEM_CHECKS.join(", ")} also reads the filesystem and runs only with ` +
  "check_filesystem: true, because a disconnected drive makes that slow. Each check reports a " +
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
    const result = runChecks(requested, {
      db: handle.db,
      assetColumns: handle.schema.assetColumns,
      volumeRoots: handle.volumeRoots,
      checkFilesystem: args.check_filesystem === true,
      warnings,
    });
    return ok({ checks: result.checks }, handle.snapshot.generation, result.warnings);
  });
}
