import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
import { takeSnapshot } from "../../src/snapshot/index.js";
import { guardSql, runSql } from "../../src/tools/run-sql.js";
import { makeMasterFixture } from "../fixtures/make.js";

const tmp = () => mkdtempSync(join(tmpdir(), "serato-sql-"));

describe("guardSql", () => {
  it("allows a single SELECT or WITH", () => {
    expect(guardSql("SELECT 1")).toBeNull();
    expect(guardSql("  select * from asset  ")).toBeNull();
    expect(guardSql("WITH x AS (SELECT 1) SELECT * FROM x")).toBeNull();
    expect(guardSql("SELECT 1;")).toBeNull();
  });

  it("refuses anything that is not a read", () => {
    for (const sql of [
      "INSERT INTO asset (id) VALUES (1)",
      "UPDATE asset SET name='x'",
      "DELETE FROM asset",
      "DROP TABLE asset",
      "ATTACH DATABASE '/x' AS y",
      "DETACH DATABASE y",
      "PRAGMA writable_schema=1",
      "CREATE TABLE t (a)",
    ]) {
      const r = guardSql(sql);
      expect(r, sql).not.toBeNull();
      if (r) expect(r.error.code).toBe("invalid_argument");
    }
  });

  it("refuses more than one statement", () => {
    const r = guardSql("SELECT 1; SELECT 2");
    expect(r).not.toBeNull();
    if (r) expect(r.error.message).toContain("one statement");
  });

  it("refuses an empty statement", () => {
    expect(guardSql("   ")).not.toBeNull();
  });

  it("is not fooled by a semicolon inside a string literal", () => {
    expect(guardSql("SELECT 'a;b'")).toBeNull();
  });

  it("is not fooled by a banned keyword inside a string literal", () => {
    expect(guardSql("SELECT 'delete from x'")).toBeNull();
  });

  it("refuses a second statement hidden after a line comment", () => {
    const r = guardSql("SELECT 1 -- \n; DROP TABLE asset");
    expect(r).not.toBeNull();
  });

  it("refuses a second statement hidden inside a block comment", () => {
    const r = guardSql("SELECT 1 /* ; */ ; DROP TABLE asset");
    expect(r).not.toBeNull();
  });

  it("allows leading whitespace or a leading comment before SELECT", () => {
    expect(guardSql("   \n  SELECT 1")).toBeNull();
    expect(guardSql("-- a comment\nSELECT 1")).toBeNull();
    expect(guardSql("/* a comment */ SELECT 1")).toBeNull();
  });

  it("is case-insensitive about the leading keyword and banned keywords", () => {
    expect(guardSql("SeLeCt 1")).toBeNull();
    const r = guardSql("select 1; Delete From asset");
    expect(r).not.toBeNull();
  });

  it("allows a backtick-quoted identifier named after a banned keyword", () => {
    expect(guardSql("SELECT `delete` FROM asset")).toBeNull();
  });

  it("allows a bracket-quoted identifier named after a banned keyword", () => {
    expect(guardSql("SELECT [create] FROM asset")).toBeNull();
  });

  // Regression: stripLiterals used to strip comments before quotes/
  // identifiers, so a "--" that is genuinely just text inside a quoted
  // region was read as a comment start and swallowed the rest of the
  // input -- including a real ";" and a real second statement sitting
  // outside the quoting. Confirmed against real node:sqlite (2026-09-06)
  // that all four of these are well-formed: db.prepare() compiles exactly
  // "SELECT 1 AS <quoted alias>" and silently ignores "; DELETE FROM t",
  // proving the ";" is a genuine top-level statement separator, not part
  // of the quoted content.
  it("refuses a real second statement even when a '--' inside quoting comes first", () => {
    for (const sql of [
      "SELECT [foo -- bar] FROM t; DELETE FROM t",
      "SELECT `foo -- bar` FROM t; DELETE FROM t",
      'SELECT "foo -- bar" FROM t; DELETE FROM t',
      "SELECT 'foo -- bar' FROM t; DELETE FROM t",
    ]) {
      const r = guardSql(sql);
      expect(r, sql).not.toBeNull();
      if (r) expect(r.error.details?.reason).toBe("multiple_statements");
    }
  });

  it("still allows an unterminated quote or bracket rather than misreading it as a second statement", () => {
    // Malformed SQL (the query will fail at prepare() later), but a
    // dangling delimiter must not make the guard see content that was
    // never actually a top-level second statement -- there is nothing left
    // outside the unterminated region for it to be.
    expect(guardSql("SELECT 'abc")).toBeNull();
    expect(guardSql("SELECT [abc")).toBeNull();
  });

  it("still allows a '--' that really is just a comment", () => {
    expect(guardSql("SELECT 1 -- this really is a comment")).toBeNull();
    // The whole ";DROP TABLE t" sits inside the comment (no newline before
    // end of input), so there is no real second statement here at all --
    // unlike the "hidden after a line comment" test above, where the ";"
    // sits after the comment's terminating newline and is genuinely a
    // second statement.
    expect(guardSql("SELECT 1 -- ;DROP TABLE t")).toBeNull();
  });
});

describe("run_sql", () => {
  // library, not livePath: run_sql resolves its own library through the
  // shared resolver now (resolveLibrary in ../../src/discovery/index.ts), the
  // same way every P2 tool will. livePath comes back too, for the one test
  // below that has to take a snapshot itself to compare generations.
  const ctx = () => {
    const dir = tmp();
    return {
      library: dir,
      livePath: makeMasterFixture(dir, {
        tracks: [
          { externalId: 1, portableId: "Users/x/a.flac", name: "A" },
          { externalId: 2, portableId: "Users/x/b.flac", name: "B" },
        ],
      }),
      cacheDir: tmp(),
    };
  };

  it("returns columns and rows from the snapshot", async () => {
    const r = await runSql(
      { sql: "SELECT external_id, name FROM asset ORDER BY external_id" },
      ctx(),
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.columns).toEqual(["external_id", "name"]);
    expect(r.rows).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
    expect(r.truncated).toBe(false);
  });

  it("binds parameters", async () => {
    const r = await runSql(
      { sql: "SELECT name FROM asset WHERE external_id = ?", params: [2] },
      ctx(),
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.rows).toEqual([["B"]]);
  });

  it("truncates at the limit and says so", async () => {
    const r = await runSql({ sql: "SELECT name FROM asset", limit: 1 }, ctx());
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.rows).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("passes a guard rejection through without touching the database", async () => {
    const r = await runSql({ sql: "DELETE FROM asset" }, ctx());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("invalid_argument");
  });

  it("turns a bad query into invalid_argument, not a crash", async () => {
    const r = await runSql({ sql: "SELECT nope FROM asset" }, ctx());
    expect(isSeratoError(r)).toBe(true);
    if (isSeratoError(r)) expect(r.error.code).toBe("invalid_argument");
  });

  // Every successful response carries generation except list_libraries.
  // ok()'s generation argument previously had no production
  // call site that ever passed a real value (list_libraries always calls it
  // with undefined), so this is what first exercises that path at all.
  it("carries the snapshot's generation", async () => {
    const context = ctx();
    const r = await runSql({ sql: "SELECT 1" }, context);
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.generation).toMatch(/^[0-9a-f]{12}$/);

    const snap = await takeSnapshot(context.livePath, context.cacheDir);
    if (isSeratoError(snap)) throw new Error("unexpected error");
    expect(r.generation).toBe(snap.generation);
  });

  // run_sql goes through the shared read path now, so it reports the same
  // schema_unknown warning every other read tool does. It never did while it
  // resolved and opened the snapshot by hand.
  it("warns about an unknown schema version, like every other read tool", async () => {
    const dir = tmp();
    makeMasterFixture(dir, { tracks: [], userVersion: 999 });
    const r = await runSql({ sql: "SELECT 1" }, { library: dir, cacheDir: tmp() });
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: "schema_unknown",
        details: expect.objectContaining({ user_version: 999 }),
      }),
    ]);
  });

  it("reports column names even when the query matches zero rows", async () => {
    const r = await runSql(
      { sql: "SELECT external_id, name FROM asset WHERE external_id = 999" },
      ctx(),
    );
    if (isSeratoError(r)) throw new Error("unexpected error");
    expect(r.columns).toEqual(["external_id", "name"]);
    expect(r.rows).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});
