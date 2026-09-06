import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { takeSnapshot } from "../snapshot/index.js";

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 200;

export const runSqlInput = z.object({
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export const runSqlDescription =
  "Run one read-only SELECT (or WITH ... SELECT) against a snapshot copy of the Serato " +
  "library. It cannot alter the library: the snapshot is a copy and the connection is " +
  "read-only. Paths are returned raw, without redaction. Registered only with --allow-raw-sql.";

/** Strips string literals and comments so that keyword and ";" detection
 *  cannot be fooled by a semicolon inside a quoted value. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function guardSql(sql: string): null | SeratoError {
  const bare = stripLiterals(sql).trim().replace(/;\s*$/, "");
  if (bare.length === 0) return err("invalid_argument", "sql is empty", { reason: "empty" });
  if (bare.includes(";")) {
    return err("invalid_argument", "run_sql takes one statement", {
      reason: "multiple_statements",
    });
  }
  if (!/^\s*(select|with)\b/i.test(bare)) {
    return err("invalid_argument", "only SELECT and WITH are allowed", { reason: "not_a_read" });
  }
  const banned =
    /\b(attach|detach|pragma|insert|update|delete|drop|create|alter|replace|vacuum|reindex)\b/i;
  const m = banned.exec(bare);
  if (m) {
    return err("invalid_argument", `keyword not allowed here: ${m[1]}`, {
      reason: "banned_keyword",
    });
  }
  return null;
}

export async function runSql(
  args: { sql: string; params?: (string | number | null)[]; limit?: number },
  ctx: { livePath: string; cacheDir: string },
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean } | SeratoError> {
  const guarded = guardSql(args.sql);
  if (guarded) return guarded;

  const snap = await takeSnapshot(ctx.livePath, ctx.cacheDir);
  if (isSeratoError(snap)) return snap;

  const limit = args.limit ?? DEFAULT_LIMIT;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(snap.path, { readOnly: true });
  } catch (e) {
    return err(
      "snapshot_failed",
      `cannot open snapshot: ${e instanceof Error ? e.message : String(e)}`,
      { attempts: 1 },
    );
  }
  try {
    // node:sqlite is synchronous and offers no interrupt(), so a runaway
    // query cannot be cancelled. busy_timeout plus the row cap is the whole
    // defence; see the risk register in the spec.
    db.exec("PRAGMA busy_timeout = 3000");
    const stmt = db.prepare(args.sql);
    const all = stmt.all(...((args.params ?? []) as never[])) as Record<string, unknown>[];
    const page = all.slice(0, limit);
    const columns = page.length > 0 ? Object.keys(page[0]) : [];
    return {
      columns,
      rows: page.map((r) => columns.map((c) => r[c])),
      truncated: all.length > limit,
    };
  } catch (e) {
    return err("invalid_argument", `query failed: ${e instanceof Error ? e.message : String(e)}`, {
      reason: "query_error",
    });
  } finally {
    db.close();
  }
}
