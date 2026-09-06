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

/** Strips string literals, quoted identifiers (double-quote, backtick, and
 *  bracket -- all four are accepted by SQLite), and comments so that keyword
 *  and ";" detection cannot be fooled by any of them, in either direction:
 *  a semicolon or keyword hidden inside one of these must not slip past the
 *  guard, and a keyword that is merely a quoted column/table name (e.g.
 *  `` `delete` `` or `[create]`) must not be refused as if it were the SQL
 *  keyword. Doubling the quote character escapes it inside '...', "...",
 *  and `...`; [...] has no such escape in SQLite, so it ends at the first
 *  "]". Verified empirically against node:sqlite 2026-09-06.
 */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, "``")
    .replace(/\[[^\]]*\]/g, "[]");
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
  // Two `try` blocks, not this file's usual single try/finally (see
  // src/snapshot/index.ts, src/discovery/index.ts,
  // src/tools/list-libraries.ts): opening the snapshot and running the
  // query fail with different, meaningful error codes (snapshot_failed vs.
  // invalid_argument), and db is only ever assigned once the first try has
  // already succeeded, so there is nothing to leak if it throws. Folding
  // both into one try/catch would need an extra discriminant (e.g.
  // inspecting the caught error) to tell the two failure kinds apart; the
  // split gets that for free.
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
    // columns() reads the statement's schema, not its data, so it is correct
    // even when the query matches zero rows -- unlike reading Object.keys()
    // off a first row, which has nothing to read in that case.
    const columns = stmt.columns().map((c) => c.name);
    // iterate(), not all(): all() would materialise the entire result set
    // (all matching rows, e.g. every track in a large library) just to have
    // most of it thrown away right after. Stopping after limit + 1 rows --
    // one past the cap -- is how truncated is known without ever reading,
    // or holding in memory, anything beyond that.
    const rows: unknown[][] = [];
    let truncated = false;
    for (const row of stmt.iterate(...((args.params ?? []) as never[]))) {
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      rows.push(columns.map((c) => row[c]));
    }
    return { columns, rows, truncated };
  } catch (e) {
    return err("invalid_argument", `query failed: ${e instanceof Error ? e.message : String(e)}`, {
      reason: "query_error",
    });
  } finally {
    db.close();
  }
}
