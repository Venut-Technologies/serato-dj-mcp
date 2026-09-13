import { z } from "zod";
import { parseToolArgs } from "../args.js";
import { ok, type Warning, warningSchema } from "../envelope.js";
import { err, isSeratoError, type SeratoError } from "../errors.js";
import { type ReadCtx, readSession, schemaWarnings } from "../read/session.js";

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
  "read-only. Paths are returned raw, without redaction. The snapshot also carries one table " +
  "this server adds and Serato does not have: mcp_key(asset_id, camelot, number, letter, " +
  "source), the tonality of each track. Registered only with --allow-raw-sql.";

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
  ctx: ReadCtx,
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

  // Through readSession like every other read tool, not by hand. It was by
  // hand until 2026-09-13, and the whole-branch review of P2 pointed out
  // what that costs: session.ts claims to be "the single read path", and
  // this tool was the one that would silently miss any change to it -- a new
  // pragma, a derived-table version check, a different snapshot policy --
  // and the only one that never reported a schema_unknown warning. Six tools
  // sharing four read paths is not one read path.
  //
  // The reason it stood apart -- wanting invalid_argument/query_error for a
  // failed statement rather than readSession's outer snapshot_failed -- is
  // satisfied inside the callback: the callback may return a SeratoError of
  // its own, and the inner catch below gets there first.
  return readSession(ctx, (handle) => {
    const warnings = schemaWarnings(handle);
    const limit = args.limit ?? DEFAULT_LIMIT;
    try {
      const stmt = handle.db.prepare(args.sql);
      // columns() reads the statement's schema, not its data, so it is
      // correct even when the query matches zero rows -- unlike reading
      // Object.keys() off a first row, which has nothing to read in that
      // case.
      const columns = stmt.columns().map((c) => c.name);
      // iterate(), not all(): all() would materialise the entire result set
      // (all matching rows, e.g. every track in a large library) just to
      // have most of it thrown away right after. Stopping after limit + 1
      // rows -- one past the cap -- is how truncated is known without ever
      // reading, or holding in memory, anything beyond that.
      const rows: unknown[][] = [];
      let truncated = false;
      for (const row of stmt.iterate(...((args.params ?? []) as never[]))) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        rows.push(columns.map((c) => row[c]));
      }
      return ok({ columns, rows, truncated }, handle.snapshot.generation, warnings);
    } catch (e) {
      return err(
        "invalid_argument",
        `query failed: ${e instanceof Error ? e.message : String(e)}`,
        { reason: "query_error" },
      );
    }
  });
}
