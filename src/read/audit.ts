import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Warning } from "../envelope.js";
import { isStreamingPortableId, portableIdToAbsolute } from "../paths.js";
import { ANCHOR_SPACE_NAME } from "./crates.js";

/** Spec 4.1: at most ten examples per check. A report is a diagnosis, not a
 *  dump -- the model asks a read tool for the rest. */
export const MAX_SAMPLES = 10;

export type CheckResult = {
  name: string;
  count: number;
  /** Present on every check except duplicates. */
  sample_ids?: number[];
  /** Present only on duplicates: a flat id list cannot say WHICH track
   *  duplicates which, and without that the finding is not actionable. */
  sample_groups?: number[][];
};

type CheckContext = {
  db: DatabaseSync;
  assetColumns: Set<string>;
  volumeRoots: Map<number, string>;
  /** Off by default, and for a reason: see FILESYSTEM_CHECKS below. */
  checkFilesystem: boolean;
  warnings: Warning[];
};

type Check = {
  name: string;
  /** Columns without which this check cannot run at all. A schema missing
   *  one gets a warning and no result, never a wrong number (spec 3.3). */
  columns: readonly string[];
  run: (ctx: CheckContext) => { count: number; sample_ids?: number[]; sample_groups?: number[][] };
};

/** Checks that touch the filesystem. Excluded unless asked for. */
export const FILESYSTEM_CHECKS: readonly string[] = ["broken_paths"];

function countAndSample(
  db: DatabaseSync,
  where: string,
  params: unknown[] = [],
): { count: number; sample_ids: number[] } {
  const { n } = db
    .prepare(`SELECT count(*) AS n FROM asset a WHERE ${where}`)
    .get(...(params as never[])) as { n: number };
  const ids = db
    .prepare(`SELECT a.id FROM asset a WHERE ${where} ORDER BY a.id LIMIT ${MAX_SAMPLES}`)
    .all(...(params as never[])) as { id: number }[];
  return { count: n, sample_ids: ids.map((r) => r.id) };
}

/**
 * Every group of tracks that look like the same recording, by either
 * criterion spec 4.1 names.
 *
 * The tag criterion runs first because it is the one that finds real
 * re-imports: measured on the owner's library 2026-09-13, it found nine
 * groups, each a file imported twice with a "-1" suffix. The size/length
 * criterion then adds groups the first missed; a group both criteria agree
 * on is reported once.
 */
function duplicateGroups(ctx: CheckContext): number[][] {
  const groups: number[][] = [];
  const seen = new Set<string>();
  const has = (c: string) => ctx.assetColumns.has(c);

  const add = (rows: { ids: string }[]) => {
    for (const row of rows) {
      const ids = row.ids
        .split(",")
        .map(Number)
        .sort((a, b) => a - b);
      const key = ids.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push(ids);
    }
  };

  if (has("artist_norm") && has("name_norm") && has("location_id") && has("is_missing")) {
    add(
      ctx.db
        .prepare(
          `SELECT group_concat(id) AS ids FROM asset WHERE is_missing = 0
             GROUP BY location_id, artist_norm, name_norm HAVING count(*) > 1`,
        )
        .all() as { ids: string }[],
    );
  }
  if (has("file_size") && has("length_ms")) {
    add(
      ctx.db
        .prepare(
          `SELECT group_concat(id) AS ids FROM asset
            WHERE file_size IS NOT NULL AND length_ms IS NOT NULL
             GROUP BY file_size, length_ms HAVING count(*) > 1`,
        )
        .all() as { ids: string }[],
    );
  }
  return groups;
}

/**
 * Walks the filesystem for tracks Serato has not itself marked missing.
 *
 * Skipped by default (FILESYSTEM_CHECKS). The reason is not CPU -- measured
 * 2026-09-13, 50 000 existsSync calls cost 94 ms -- it is that a DJ's
 * library routinely lives on an external drive, and a stat against a
 * disconnected or spun-down volume blocks for seconds. This server is
 * synchronous with no way to interrupt a call, so one such stat stalls every
 * other tool.
 *
 * A location whose volume root is not mounted is therefore reported as a
 * warning and skipped entirely, rather than having every one of its tracks
 * declared missing -- which is what a naive pass would conclude.
 */
function brokenPaths(ctx: CheckContext): { count: number; sample_ids: number[] } {
  const flagged = countAndSample(ctx.db, "a.is_missing <> 0");
  if (!ctx.checkFilesystem) return flagged;

  const rows = ctx.db
    .prepare("SELECT id, location_id, portable_id FROM asset WHERE is_missing = 0")
    .all() as { id: number; location_id: number; portable_id: string }[];

  const mounted = new Map<number, boolean>();
  const isMounted = (locationId: number): boolean => {
    const cached = mounted.get(locationId);
    if (cached !== undefined) return cached;
    const root = ctx.volumeRoots.get(locationId);
    // An unknown root cannot be checked; treat it as unmounted so the
    // warning path reports it instead of guessing.
    const ok = root === undefined ? false : root === "/" || existsSync(root);
    mounted.set(locationId, ok);
    if (!ok) {
      ctx.warnings.push({
        code: "location_disconnected",
        message: `location ${locationId} is not mounted; its files were not checked on disk`,
        details: { location_id: locationId, volume_root: root ?? null },
      });
    }
    return ok;
  };

  const missing: number[] = [...flagged.sample_ids];
  let count = flagged.count;
  for (const row of rows) {
    // A streaming id is not a filesystem path and must never be turned into
    // one (spec 2.3).
    if (isStreamingPortableId(row.portable_id)) continue;
    if (!isMounted(row.location_id)) continue;
    const root = ctx.volumeRoots.get(row.location_id);
    if (root === undefined) continue;
    if (existsSync(portableIdToAbsolute(root, row.portable_id))) continue;
    count += 1;
    if (missing.length < MAX_SAMPLES) missing.push(row.id);
  }
  return { count, sample_ids: missing };
}

/**
 * The audit's checks, each with the exact criterion it claims.
 *
 * missing_key reads the derived mcp_key table rather than `key_value < 0`,
 * which is what spec 4.1 said before stage P2 existed. On the owner's
 * library that criterion counts 79 tracks, of which only 4 actually have no
 * key -- the other 75 have one this server can read and its own search
 * matches, so calling them "missing" would make the audit contradict the
 * search. Those 75 are a real and separate finding, and they get their own
 * check: Serato's own display and its own harmonic tools cannot see them.
 */
export const CHECKS: readonly Check[] = [
  {
    name: "missing_bpm",
    columns: ["bpm"],
    run: (ctx) => countAndSample(ctx.db, "a.bpm IS NULL"),
  },
  {
    name: "missing_key",
    columns: ["id"],
    run: (ctx) =>
      countAndSample(ctx.db, "NOT EXISTS (SELECT 1 FROM mcp_key k WHERE k.asset_id = a.id)"),
  },
  {
    name: "key_unreadable_by_serato",
    columns: ["key_value"],
    run: (ctx) =>
      countAndSample(
        ctx.db,
        "a.key_value < 0 AND EXISTS (SELECT 1 FROM mcp_key k WHERE k.asset_id = a.id)",
      ),
  },
  {
    name: "stale",
    columns: ["is_stale"],
    run: (ctx) => countAndSample(ctx.db, "a.is_stale <> 0"),
  },
  {
    name: "not_in_any_crate",
    columns: ["id"],
    // "Crate" here means what list_crates means by it: a type = 1 container
    // in the anchor space. Counting Serato's Prepare panel as a crate would
    // make this number disagree with what the crate tools show.
    run: (ctx) =>
      countAndSample(
        ctx.db,
        `NOT EXISTS (
           SELECT 1 FROM container_asset ca
             JOIN location_container lc ON lc.id = ca.location_container_id
             JOIN container c ON c.id = lc.container_id
             JOIN space s ON s.id = c.space_id
            WHERE ca.asset_id = a.id AND c.type = 1 AND s.name = ? COLLATE NOCASE)`,
        [ANCHOR_SPACE_NAME],
      ),
  },
  {
    name: "streaming_only",
    columns: ["third_party_type", "portable_id"],
    run: (ctx) =>
      countAndSample(ctx.db, "a.third_party_type <> 0 OR a.portable_id LIKE 'streaming://%'"),
  },
  {
    name: "duplicates",
    columns: ["id"],
    run: (ctx) => {
      const groups = duplicateGroups(ctx);
      return { count: groups.length, sample_groups: groups.slice(0, MAX_SAMPLES) };
    },
  },
  {
    name: "broken_paths",
    columns: ["is_missing", "portable_id"],
    run: brokenPaths,
  },
];

export const CHECK_NAMES: readonly string[] = CHECKS.map((c) => c.name);

/** Everything that needs no filesystem access -- the default set. */
export const DEFAULT_CHECK_NAMES: readonly string[] = CHECK_NAMES.filter(
  (n) => !FILESYSTEM_CHECKS.includes(n),
);

export function runChecks(
  names: readonly string[],
  ctx: CheckContext,
): { checks: CheckResult[]; warnings: Warning[] } {
  const results: CheckResult[] = [];
  for (const name of names) {
    const check = CHECKS.find((c) => c.name === name);
    if (check === undefined) continue;
    const absent = check.columns.filter((c) => !ctx.assetColumns.has(c));
    if (absent.length > 0) {
      // A check that cannot run reports nothing rather than a wrong number,
      // and says why (spec 3.3).
      ctx.warnings.push({
        code: "check_unavailable",
        message: `this Serato schema cannot run the ${name} check`,
        details: { check: name, columns: absent },
      });
      continue;
    }
    results.push({ name, ...check.run(ctx) });
  }
  return { checks: results, warnings: ctx.warnings };
}
