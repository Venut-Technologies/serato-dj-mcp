import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSeratoError } from "../../src/errors.js";
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
});

describe("run_sql", () => {
  const ctx = () => {
    const dir = tmp();
    return {
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
