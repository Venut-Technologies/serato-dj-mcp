import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What must never reach a published repository, as a test rather than as a
 * habit. It reads the tracked file list from git, so a new file is covered
 * the moment it is added.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every tracked file, whatever its extension -- a .txt, a .toml, or an
// extensionless file like LICENSE is just as able to carry the owner's data
// as a .ts one. What can't be read as text is skipped in readTextOrNull
// below, by content, not by name.
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((p) => p !== "");

// This file's own path, as `tracked` spells it (git ls-files always uses
// "/"). Its source quotes the very patterns and allowed values the rules
// below look for, so the pattern-bearing rules skip it rather than lean on
// incidental non-matches.
const SELF_PATH = relative(ROOT, fileURLToPath(import.meta.url));

/** The file's text, or null if it isn't text (a NUL byte says binary). */
function readTextOrNull(path: string): string | null {
  const buf = readFileSync(join(ROOT, path));
  return buf.includes(0) ? null : buf.toString("utf8");
}

/**
 * Visits every scannable line of every tracked file except this one -- the
 * pattern-bearing rules all read through this, so none of them has to
 * repeat the binary/self-file skip.
 */
function forEachLine(visit: (path: string, lineNo: number, line: string) => void): void {
  for (const path of tracked) {
    if (path === SELF_PATH) continue;
    const text = readTextOrNull(path);
    if (text === null) continue; // binary: not scanned as text
    text.split("\n").forEach((line, i) => {
      visit(path, i + 1, line);
    });
  }
}

/** Hits with the file and line, so a failure says where to look. */
function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  forEachLine((path, lineNo, line) => {
    for (const m of line.matchAll(pattern)) found.push(`${path}:${lineNo}: ${m[0]}`);
  });
  return found;
}

// The only two database identifiers a tracked file may carry, in bare hex.
// Every identifier rule below derives its allowed form from this one list.
const SYNTHETIC_IDS = ["11111111111111111111111111111111", "22222222222222222222222222222222"];

describe("repository hygiene", () => {
  it("tracks no file list of its own that git does not know about", () => {
    // Guards the guard: an empty tracked list would make every rule vacuous.
    expect(tracked.length).toBeGreaterThan(30);
  });

  // A SQLite blob literal in a fixture is a database identity. The two the
  // schema needs are synthetic and declared here; anything else is the
  // owner's own library leaking into a public file.
  it("carries no database identifier but the synthetic ones", () => {
    const allowed = new Set(SYNTHETIC_IDS.map((id) => `X'${id}'`));
    const found = hits(/X'[0-9a-fA-F]{16,}'/g).filter(
      (h) => !allowed.has(h.slice(h.indexOf("X'"))),
    );
    expect(found).toEqual([]);
  });

  // The same identifier can leak outside a blob literal too -- a bare hex
  // string handed to Buffer.from(hex); written with '-' separators, as a
  // canonical UUID; or run together with extra hex characters and no
  // separator at all. A run of hex digits and dashes is suspect once
  // stripping the dashes leaves 32 or more hex characters -- long enough to
  // carry either synthetic id, or the real thing. Kept as its own rule so a
  // failure says which form slipped through.
  it("carries no database identifier as a bare hex run either", () => {
    const allowed = new Set(SYNTHETIC_IDS);
    const found: string[] = [];
    forEachLine((path, lineNo, line) => {
      for (const m of line.matchAll(/[0-9a-f-]+/gi)) {
        const normalized = m[0].replace(/-/g, "").toLowerCase();
        if (normalized.length >= 32 && !allowed.has(normalized)) {
          found.push(`${path}:${lineNo}: ${m[0]}`);
        }
      }
    });
    expect(found).toEqual([]);
  });

  // Paths in examples and fixtures must be invented. These stand-ins are the
  // ones the suite already uses.
  it("names no real user or volume in a path", () => {
    const users = hits(/\/Users\/[A-Za-z0-9._-]+/g).filter(
      (h) => !/\/Users\/(x|v|me)$/.test(h.slice(h.indexOf("/Users/"))),
    );
    const volumes = hits(/\/Volumes\/[A-Za-z0-9._-]+/g).filter(
      (h) => !/\/Volumes\/(DISK|EXTDISK|USB|X)$/.test(h.slice(h.indexOf("/Volumes/"))),
    );
    expect([...users, ...volumes]).toEqual([]);
  });

  // A comment that cites "spec 5.4" or "Ruling 10" cites a document nobody
  // outside this machine has. What it knew has to be said in the comment.
  // Built from character classes rather than the literal words themselves,
  // so this pattern does not describe itself -- moot while SELF_PATH is
  // skipped, but true independently of that skip too. Besides the numbered
  // forms (any case), it also catches the two forms a numbered citation
  // never took: "P2 review" (a project phase standing in for a document)
  // and "review ... finding 3" (a numbered item inside one).
  const INTERNAL_REFERENCE =
    /\b[Ss][Pp][Ee][Cc]\s\d+(?:\.\d+)*|\b[Rr][Uu][Ll][Ii][Nn][Gg]\s\d+|\b[Dd][Ee][Cc][Ii][Ss][Ii][Oo][Nn]\s\d+|\b[Aa][Mm][Ee][Nn][Dd][Mm][Ee][Nn][Tt]\s\d+|\b[Pp][1-4]\s+[Rr][Ee][Vv][Ii][Ee][Ww]\b|\b[Rr][Ee][Vv][Ii][Ee][Ww]\b\s+[Oo][Ff]\s+[Pp][1-4]\b|\b[Rr][Ee][Vv][Ii][Ee][Ww]\b[^\n]{0,24}[Ff][Ii][Nn][Dd][Ii][Nn][Gg]\s\d+|ПОПРАВКА/g;

  it("points at no internal document from tracked source", () => {
    const found = hits(INTERNAL_REFERENCE).filter(
      (h) => h.startsWith("src/") || h.startsWith("tests/"),
    );
    expect(found).toEqual([]);
  });

  // A wrapped comment can break its own citation in two -- "review" at the
  // end of one line, "2026-09-13, finding 1)" at the start of the next --
  // which a single-line scan reads as two harmless fragments. Joining each
  // line with the next (its own comment marker stripped first) and keeping
  // only matches that straddle the join catches that split without
  // double-reporting what forEachLine's single-line pass already finds.
  function hitsAcrossLineWrap(pattern: RegExp): string[] {
    const found: string[] = [];
    for (const path of tracked) {
      if (path === SELF_PATH) continue;
      const text = readTextOrNull(path);
      if (text === null) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const a = lines[i];
        const b = lines[i + 1].replace(/^\s*(?:\*\/|\*|\/\/)?\s*/, "");
        const joined = `${a} ${b}`;
        const joinAt = a.length;
        for (const m of joined.matchAll(pattern)) {
          if (m.index !== undefined && m.index < joinAt && m.index + m[0].length > joinAt) {
            found.push(`${path}:${i + 1}-${i + 2}: ${m[0].replace(/\s+/g, " ")}`);
          }
        }
      }
    }
    return found;
  }

  it("points at no internal document split across a comment's line wrap", () => {
    const found = hitsAcrossLineWrap(INTERNAL_REFERENCE).filter(
      (h) => h.startsWith("src/") || h.startsWith("tests/"),
    );
    expect(found).toEqual([]);
  });
});
