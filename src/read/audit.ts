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
  /** Checked the way session.ts checks before reading `connection`: a
   *  renamed table must warn and degrade, not throw and be reported as a
   *  broken snapshot (spec 3.3). */
  tables: Set<string>;
  volumeRoots: Map<number, string>;
  /** Off by default, and for a reason: see FILESYSTEM_CHECKS below. */
  checkFilesystem: boolean;
  warnings: Warning[];
};

type CheckOutcome = { count: number; sample_ids?: number[]; sample_groups?: number[][] };

type Check = {
  name: string;
  /** Columns without which this check cannot run at all. A schema missing
   *  one gets a warning and no result, never a wrong number (spec 3.3). */
  columns: readonly string[];
  /** Tables beyond `asset` that the check's SQL names. */
  tables?: readonly string[];
  /** A requirement the columns list cannot express, because that list is an
   *  AND and some checks need an OR. Returns the missing columns, or []. */
  requires?: (assetColumns: Set<string>) => string[];
  /** undefined means "could not be determined": reported as a warning and
   *  omitted from the report, never as a zero. */
  run: (ctx: CheckContext) => CheckOutcome | undefined;
};

/**
 * Checks with a filesystem pass. The check itself still runs by default --
 * spec 4.1 makes only the *disk access* opt-in, and the database half
 * (Serato's own is_missing flag) is a free, real finding. Excluding the
 * whole check made `check_filesystem: true` a silent no-op unless the caller
 * also named broken_paths, the opposite of what its own description
 * promised. Found by review 2026-09-14.
 */
export const FILESYSTEM_CHECKS: readonly string[] = ["broken_paths"];

/**
 * One predicate, two statements: the total and up to ten examples. They
 * cannot disagree -- same WHERE, same immutable snapshot inside one
 * readSession, deterministic order.
 */
function countAndSample(
  db: DatabaseSync,
  where: string,
  params: unknown[] = [],
  withClause = "",
): { count: number; sample_ids: number[] } {
  const prefix = withClause === "" ? "" : `${withClause} `;
  const { n } = db
    .prepare(`${prefix}SELECT count(*) AS n FROM asset a WHERE ${where}`)
    .get(...(params as never[])) as { n: number };
  const ids = db
    .prepare(`${prefix}SELECT a.id FROM asset a WHERE ${where} ORDER BY a.id LIMIT ${MAX_SAMPLES}`)
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
function brokenPaths(ctx: CheckContext): CheckOutcome | undefined {
  const flagged = countAndSample(ctx.db, "a.is_missing <> 0");
  if (!ctx.checkFilesystem) return flagged;

  const rows = ctx.db
    .prepare("SELECT id, location_id, portable_id FROM asset WHERE is_missing = 0")
    .all() as { id: number; location_id: number; portable_id: string }[];

  const checkable = new Map<number, boolean>();
  const isCheckable = (locationId: number): boolean => {
    const cached = checkable.get(locationId);
    if (cached !== undefined) return cached;
    const root = ctx.volumeRoots.get(locationId);
    // Two different failures, and telling a DJ to plug in a drive that is
    // already plugged in is the wrong one to report. A root we could not
    // derive at all (an unparseable connection.database_uri, or no
    // connection row -- see volumeRoots in ../read/session.ts) says nothing
    // about whether the volume is mounted.
    if (root === undefined) {
      checkable.set(locationId, false);
      ctx.warnings.push({
        code: "location_root_unknown",
        message: `no volume root could be derived for location ${locationId}, so its files were not checked on disk`,
        details: { location_id: locationId, reason: "unparseable_database_uri" },
      });
      return false;
    }
    const mounted = root === "/" || existsSync(root);
    checkable.set(locationId, mounted);
    if (!mounted) {
      ctx.warnings.push({
        code: "location_disconnected",
        message: `location ${locationId} is not mounted, so its files were not checked on disk`,
        details: { location_id: locationId, volume_root: root },
      });
    }
    return mounted;
  };

  const onDisk: number[] = [];
  let gone = 0;
  let checkedLocations = 0;
  const seenLocations = new Set<number>();
  for (const row of rows) {
    // A streaming id is not a filesystem path and must never be turned into
    // one (spec 2.3).
    if (isStreamingPortableId(row.portable_id)) continue;
    if (!seenLocations.has(row.location_id)) {
      seenLocations.add(row.location_id);
      if (isCheckable(row.location_id)) checkedLocations += 1;
    }
    if (!isCheckable(row.location_id)) continue;
    const root = ctx.volumeRoots.get(row.location_id);
    if (root === undefined) continue;
    if (existsSync(portableIdToAbsolute(root, row.portable_id))) continue;
    gone += 1;
    if (onDisk.length < MAX_SAMPLES) onDisk.push(row.id);
  }

  // Nothing could be checked: reporting 0 would be a positive claim -- "no
  // broken paths" -- where the truth is "not checked". Same rule the
  // check_unavailable path follows below.
  if (seenLocations.size > 0 && checkedLocations === 0) return undefined;

  // The count is the union spec 4.1 describes, but the two halves need
  // different remedies -- relocate inside Serato, versus re-import -- so the
  // split is stated rather than left for the caller to infer from one number.
  ctx.warnings.push({
    code: "broken_paths_breakdown",
    message: `${flagged.count} flagged missing by Serato, ${gone} more absent from disk`,
    details: {
      flagged_by_serato: flagged.count,
      absent_from_disk: gone,
      locations_checked: checkedLocations,
      locations_skipped: seenLocations.size - checkedLocations,
    },
  });

  // Disk-discovered ids lead: they are what the caller opted in for, and
  // filling the ten slots with already-flagged rows would say nothing new.
  const sample = [...onDisk, ...flagged.sample_ids].slice(0, MAX_SAMPLES);
  return { count: flagged.count + gone, sample_ids: sample };
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
    tables: ["mcp_key"],
    // The columns list is an AND and this requirement is an OR: the answer
    // comes from mcp_key, which derive.ts fills from either key column. With
    // neither, mcp_key is empty and this check would report EVERY track as
    // keyless, with nothing to say it had no basis.
    requires: (columns) =>
      columns.has("key_value") || columns.has("key") ? [] : ["key_value", "key"],
    run: (ctx) =>
      countAndSample(ctx.db, "NOT EXISTS (SELECT 1 FROM mcp_key k WHERE k.asset_id = a.id)"),
  },
  {
    name: "key_unreadable_by_serato",
    columns: ["key_value"],
    tables: ["mcp_key"],
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
    tables: ["container_asset", "location_container", "container", "space"],
    // "Crate" here means what list_crates means by it: a type = 1 container
    // in the anchor space. Counting Serato's Prepare panel as a crate would
    // make this number disagree with what the crate tools show.
    //
    // MATERIALIZED, not a correlated NOT EXISTS. container_asset has no
    // index on asset_id -- its three are on location_container_id,
    // space_asset_id and external_container_asset_id -- so the correlated
    // form scans that whole table once per track. Measured 2026-09-14 on a
    // synthetic 50 118-track library with 15 015 memberships: 13.2 s per
    // pass, and countAndSample runs the predicate twice, so 26 s of a
    // synchronous server that cannot interrupt itself. The materialized CTE
    // gives the identical answer in 41 ms.
    run: (ctx) =>
      countAndSample(
        ctx.db,
        "a.id NOT IN (SELECT asset_id FROM crate_members)",
        [ANCHOR_SPACE_NAME],
        `WITH crate_members(asset_id) AS MATERIALIZED (
           SELECT DISTINCT ca.asset_id FROM container_asset ca
             JOIN location_container lc ON lc.id = ca.location_container_id
             JOIN container c ON c.id = lc.container_id
             JOIN space s ON s.id = c.space_id
            WHERE c.type = 1 AND s.name = ? COLLATE NOCASE)`,
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

/** Every check runs by default. Only broken_paths' DISK PASS is opt-in --
 *  its database half costs nothing and finds real breakage (spec 4.1). */
export const DEFAULT_CHECK_NAMES: readonly string[] = CHECK_NAMES;

export function runChecks(
  names: readonly string[],
  ctx: CheckContext,
): { checks: CheckResult[]; warnings: Warning[] } {
  const results: CheckResult[] = [];
  const unavailable = (name: string, what: string, missing: string[]) => {
    // A check that cannot run reports nothing rather than a wrong number,
    // and says why (spec 3.3).
    ctx.warnings.push({
      code: "check_unavailable",
      message: `this Serato schema cannot run the ${name} check`,
      details: { check: name, [what]: missing },
    });
  };

  // Deduplicated: the same name twice would run the same two queries twice
  // and appear twice in a report the model reads as a list of distinct
  // findings.
  for (const name of [...new Set(names)]) {
    const check = CHECKS.find((c) => c.name === name);
    if (check === undefined) continue;

    const absentColumns = check.columns.filter((c) => !ctx.assetColumns.has(c));
    const alsoRequired = check.requires?.(ctx.assetColumns) ?? [];
    if (absentColumns.length > 0 || alsoRequired.length > 0) {
      unavailable(name, "columns", [...absentColumns, ...alsoRequired]);
      continue;
    }
    const absentTables = (check.tables ?? []).filter((t) => !ctx.tables.has(t));
    if (absentTables.length > 0) {
      unavailable(name, "tables", absentTables);
      continue;
    }

    const outcome = check.run(ctx);
    if (outcome === undefined) {
      ctx.warnings.push({
        code: "check_undetermined",
        message: `the ${name} check could not be determined on this library`,
        details: { check: name },
      });
      continue;
    }
    results.push({ name, ...outcome });
  }
  // A copy, not the context's own array: every sibling module returns
  // warnings for the caller to spread, and aliasing them makes the caller's
  // list and this one the same object.
  return { checks: results, warnings: [...ctx.warnings] };
}
