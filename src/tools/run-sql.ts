import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { resolveLibrary } from "../discovery/index.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { takeSnapshot } from "../snapshot/index.js";

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 200;

export const runSqlInput = z.object({
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

// node:sqlite hands back TEXT, INTEGER/REAL and NULL as string, number and
// null -- verified 2026-09-06. BLOB comes back as a Uint8Array, but
// z.instanceof(Uint8Array) has no JSON Schema representation: the SDK's
// tools/list conversion of the outputSchema itself throws ("Custom types
// cannot be represented in JSON Schema") the moment a schema contains one,
// which broke every tool's listing, not just this one's validation. BLOB's
// wire serialisation shape is out of scope for this wave (it is still
// returned as-is, unconverted), so it is covered here with z.any() rather
// than solved.
const sqlValueSchema = z.union([z.string(), z.number(), z.null(), z.any()]);

export const runSqlOutput = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(sqlValueSchema)),
  truncated: z.boolean(),
  generation: z.string(),
  warnings: z.array(warningSchema).optional(),
});

export const runSqlDescription =
  "Run one read-only SELECT (or WITH ... SELECT) against a snapshot copy of the Serato " +
  "library. It cannot alter the library: the snapshot is a copy and the connection is " +
  "read-only. Paths are returned raw, without redaction. Registered only with --allow-raw-sql.";

type ScanState =
  | "normal"
  | "single"
  | "double"
  | "backtick"
  | "bracket"
  | "line_comment"
  | "block_comment";

/**
 * Strips string literals, quoted identifiers (double-quote, backtick, and
 * bracket -- all four are accepted by SQLite), and comments so that keyword
 * and ";" detection cannot be fooled by any of them, in either direction: a
 * semicolon or keyword hidden inside one of these must not slip past the
 * guard, and a keyword that is merely a quoted column/table name (e.g.
 * `` `delete` `` or `[create]`) must not be refused as if it were the SQL
 * keyword.
 *
 * A single left-to-right scan that tracks exactly one lexical state at a
 * time, not a sequence of independent regexes. Regexes applied one after
 * another cannot get this right in principle: quoting and comments are
 * mutually exclusive contexts, and which one a given position is in can
 * only be decided by having already scanned everything before it. Fixed
 * 2026-09-06: the previous version stripped comments first, so a "--"
 * that was genuinely just text inside a quoted region (e.g.
 * `SELECT 'foo -- bar' FROM t; DELETE FROM t`) was read as a comment
 * start and swallowed the rest of the input -- including a real ";" and a
 * real second statement sitting outside the quoting. Confirmed against
 * node:sqlite that such input is well-formed: prepare() compiles exactly
 * the SELECT and silently ignores the rest, proving the ";" is real.
 *
 * Doubling the quote character escapes it inside '...', "...", and
 * `...`; [...] has no such escape in SQLite, so it ends at the first "]".
 * An unterminated quote, bracket, or block comment consumes to the end of
 * the input rather than reporting an error here -- matching node:sqlite's
 * own tokenizer, which does the same (verified empirically 2026-09-06).
 */
function stripLiterals(sql: string): string {
  let state: ScanState = "normal";
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const c2 = sql[i + 1] ?? "";
    if (state === "normal") {
      if (c === "-" && c2 === "-") {
        out += " ";
        state = "line_comment";
        i += 2;
      } else if (c === "/" && c2 === "*") {
        out += " ";
        state = "block_comment";
        i += 2;
      } else if (c === "'" || c === '"' || c === "`" || c === "[") {
        out += c;
        state = c === "'" ? "single" : c === '"' ? "double" : c === "`" ? "backtick" : "bracket";
        i += 1;
      } else {
        out += c;
        i += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "backtick") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (c === quote && c2 === quote) {
        i += 2; // doubled quote: an escaped literal quote, stay inside
      } else if (c === quote) {
        out += quote;
        state = "normal";
        i += 1;
      } else {
        i += 1; // swallow content
      }
      continue;
    }
    if (state === "bracket") {
      if (c === "]") {
        out += "]";
        state = "normal";
      }
      i += 1;
      continue;
    }
    if (state === "line_comment") {
      if (c === "\n") {
        out += "\n";
        state = "normal";
      }
      i += 1;
      continue;
    }
    // block_comment
    if (c === "*" && c2 === "/") {
      state = "normal";
      i += 2;
    } else {
      i += 1;
    }
  }
  return out;
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

/**
 * `raw` is whatever the caller sent, unparsed: the arguments of a tool are
 * validated here, by the tool that owns the schema, rather than by the
 * transport above it (see parseToolArgs in ../args.ts and the note on
 * dispatch in ../server.ts). Calling this function directly -- a test, a
 * future in-process caller -- therefore gets the same validation and the
 * same `invalid_argument` value as a call arriving over MCP.
 */
export async function runSql(
  raw: unknown,
  ctx: { library?: string; roots?: string[]; cacheDir: string },
): Promise<
  | ({ columns: string[]; rows: unknown[][]; truncated: boolean } & {
      generation?: string;
      warnings?: Warning[];
    })
  | SeratoError
> {
  const args = parseToolArgs(runSqlInput, raw);
  if (isSeratoError(args)) return args;

  const guarded = guardSql(args.sql);
  if (guarded) return guarded;

  // Resolved here rather than handed in: one shared resolver for every tool
  // (spec 3.1 keeps the tool layer clear of the server, so a resolution
  // living in server.ts could only ever serve one caller). Ordered after
  // guardSql so a refused statement costs no filesystem work.
  const lib = resolveLibrary({ library: ctx.library, roots: ctx.roots });
  if (isSeratoError(lib)) return lib;

  const snap = await takeSnapshot(lib.masterPath, ctx.cacheDir);
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
    // Spec 4.0: every successful response carries generation except
    // list_libraries. This is the only production call site of ok() with a
    // real generation -- list_libraries always calls it with undefined --
    // so this is also what first exercises that argument of ok() at all.
    return ok({ columns, rows, truncated }, snap.generation);
  } catch (e) {
    return err("invalid_argument", `query failed: ${e instanceof Error ? e.message : String(e)}`, {
      reason: "query_error",
    });
  } finally {
    db.close();
  }
}
