# serato-dj-mcp

[![CI](https://github.com/Venut-Technologies/serato-dj-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Venut-Technologies/serato-dj-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Status: Experimental · Active · Pre-1.0**

Talk to your Serato DJ library from an AI assistant. `serato-dj-mcp` is a local
[Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude, or any other MCP
client, search your tracks by BPM, key and genre, look inside your crates, find gaps and
duplicates in the library, and — only when you switch it on — build new crates for you.

> [!IMPORTANT]
> **Not affiliated with, endorsed by, or supported by Serato.** Serato and Serato DJ are
> trademarks of their respective owner. This project reads a reverse-engineered database layout
> and can stop working after any Serato update.

## What you can ask

Once the server is connected, you talk to your assistant as usual:

- "Find tracks between 122 and 126 BPM in 8A or 9A that I added this year."
- "Which tracks in my library have no BPM or no key?"
- "Show me what's in my *Warm Up* crate, in order."
- "Audit my library: duplicates, missing files, tracks that aren't in any crate."
- "Give me tracks that mix harmonically out of 8A, around 124 BPM."

With writes enabled (`--allow-writes`):

- "Build a crate called *Friday Opening* from the twenty tracks you just found, and show me the
  list before writing anything."
- "I've closed Serato — apply the staged crate."

The assistant does the searching; the server answers from your library and, when asked, writes
only what you approved.

## Compatibility

| | |
|---|---|
| **Serato DJ 4.x** | Supported. Developed and tested against Serato DJ Lite 4.0.9 (library schema 202). Other 4.x schema versions are read with a `schema_unknown` warning. Serato DJ Pro 4.x is expected to use the same library format but has not been tested. |
| **Serato DJ 3.x** | Detected and reported, not read (it keeps a binary `database V2` instead of SQLite). |
| **macOS** | Supported. This is where the project is developed, and CI runs on it. |
| **Windows** | Untested. The server has no Windows-specific handling: pass `--library` explicitly, because automatic discovery only knows the macOS layout, and expect macOS-style cache and state directories under your user folder. The "is Serato running" check uses `ps`, which Windows does not have, so `apply_changes` may refuse to write rather than guess. |
| **Linux** | Serato does not run on Linux; the test suite runs there in CI on synthetic fixtures. |
| **Node.js** | 22.16 or newer. |

Everything this server assumes about the Serato library is written down in
[docs/serato-4x-notes.md](docs/serato-4x-notes.md), with the measurement behind each claim.

## Install

The package is **not published to npm yet**. Until the first release, run it from source:

```sh
git clone https://github.com/Venut-Technologies/serato-dj-mcp.git
cd serato-dj-mcp
npm ci
npm run build
```

Then point your MCP client at the built server. For Claude Desktop, in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "serato": {
      "command": "node",
      "args": ["/absolute/path/to/serato-dj-mcp/dist/index.js"]
    }
  }
}
```

Claude Code: `claude mcp add serato -- node /absolute/path/to/serato-dj-mcp/dist/index.js`

Add `"--allow-writes"` to `args` only if you want crate writing (see below).

Once a release is on npm, the same configuration will work with
`"command": "npx", "args": ["-y", "serato-dj-mcp"]`.

This server uses `backup()` from `node:sqlite`, which was added in Node 22.16. `node:sqlite` is
an experimental Node API and prints a warning to stderr; that is expected and harmless, because
the MCP protocol travels over stdout.

## Read-only by default, writes on request

**By default the server never writes to Serato's files.** Every read goes through a snapshot
copy of the library database in `--cache-dir`, so a question from the assistant cannot change your
library, whether Serato is open or not.

Two flags widen that, and each registers extra tools only when it is given — a tool that does not
exist cannot be called by mistake:

- `--allow-raw-sql` adds `run_sql`: read-only `SELECT` against the snapshot, returning raw rows.
- `--allow-writes` adds `stage_crate`, `preview_changes`, `apply_changes` and `discard_changes`.
  Writing is split in two: crates are *staged* first, which never touches the library, and are
  *applied* only when you confirm and Serato is closed. Both databases are backed up before every
  write. The details are in [Writing to the library](#writing-to-the-library).

## Tools

- `list_libraries` — the libraries this server can see, with version, schema
  version and locations. Paths here are not redacted, so you can copy one into
  `--library`.
- `search_tracks` — search by free text, BPM, key, genre, rating, date added, crate
  membership and flags. Tonality is Camelot; a track whose key Serato itself could not
  parse is still matched, and `key_source` says where the key came from. Paginated with an
  opaque cursor; the default page is 25 tracks and nine fields.
- `get_tracks` — fetch tracks by the ids `search_tracks` returned. Unknown ids come back in
  `missing` rather than being dropped.
- `list_crates` — the crates in the Serato Library space, with their display path and how many
  distinct tracks each holds. Smart crates, space roots and Serato's other internal spaces
  (such as the Prepare panel) are not listed.
- `get_crate_tracks` — the tracks of one crate, in the crate's own order. Only crates in the
  Serato Library space can be given.
- `audit_library` — diagnose the library. Every check runs by default and reports a count plus
  up to ten example track ids: tracks with no BPM, with no key at all, with a key Serato itself
  cannot display, marked stale, in no crate, streaming-only, duplicated, and with broken paths.
  `duplicates` reports groups instead of loose ids, because which track duplicates which is the
  part you can act on. `broken_paths` reads Serato's own missing flag by default; pass
  `check_filesystem: true` to also look on disk, which is opt-in because a stat against a
  disconnected drive blocks for seconds. A drive that is not mounted is reported as such rather
  than having all its tracks declared missing.
- `run_sql` — one read-only `SELECT` against a snapshot copy. Registered only
  with `--allow-raw-sql`, because it returns raw rows with no path redaction.

With `--allow-writes`:

- `stage_crate` — stage a new crate from track ids. Nothing is written yet; the response lists
  every staged track by title and artist, so check it.
- `preview_changes` — show what is staged, with `format: "detail"` down to each track.
- `apply_changes` — write everything staged, all or nothing. Refused while Serato is running.
- `discard_changes` — drop one staged crate, or all of them.

## Options

`--library <path>`, `--root <dir>` (repeatable), `--cache-dir <dir>`,
`--state-dir <dir>`, `--allow-raw-sql`, `--allow-writes`, `--help`,
`--version`. `SERATO_LIBRARY_PATH` is an alternative to `--library`;
the flag wins. An unknown option is an error, not a no-op.

## Writing to the library

Writes need `--allow-writes` and happen in two steps, because Serato must be closed while its
database is written and the model usually works while it is open. `stage_crate` can run at any
time; `apply_changes` refuses while Serato is running. Start Serato afterwards and the new crates
appear within a few seconds.

What a write does: it creates new crates at the top level of the Serato Library, in
`root.sqlite`, and nothing else. It never changes or deletes an existing crate, never edits a
track, never touches `master.sqlite`, `database V2` or the `Subcrates` folder — Serato regenerates
those itself.

Before every write both databases are backed up under
`<state-dir>/backups/<library-id>/<timestamp>/` (default state-dir:
`~/Library/Application Support/serato-dj-mcp`), and the last ten are kept. A backup is taken on
every `apply_changes` attempt that reaches the backup step, including attempts that are then
refused inside the transaction (a name conflict, for example) — so "the last ten" means the last
ten *attempts*, not ten successful writes, and the newest one may already contain the write you
are trying to undo.

**There is no undo tool.** To undo a specific write, first find the right backup: use the
`backup_paths` returned by that `apply_changes` call, or open
`<state-dir>/manifests/<library-id>.jsonl` and take the `backup_paths` of the line whose
`"commit_state"` is `"committed"`. `<library-id>` is the `uuid` reported by `list_libraries`. Then,
with that pair of paths in hand:

1. Quit Serato.
2. In the library folder, delete `root.sqlite-journal` if present, and delete
   `master.sqlite-wal` and `master.sqlite-shm`.
3. Copy the backed-up `root.sqlite` and `master.sqlite` into the library folder, replacing the
   current ones.
4. Delete `~/Music/_Serato_/Subcrates/<crate name>.crate` — Serato exported it after it synced
   the crate, and copying the databases back does not remove it.

Restoring these files also rolls back anything Serato itself recorded in the library after that
backup was taken.

Nested crates are not supported: a crate created this way inside another crate is deleted by
Serato when it next syncs, so every crate goes to the top level.

## Privacy

- **Everything runs on your computer.** The server is a local process your MCP client starts. It
  sends no telemetry, has no analytics, and makes no network requests. The only other program it
  runs is `ps`, to check whether Serato is running before a write.
- **What it reads:** Serato's library databases, always read-only except for `apply_changes`;
  with `audit_library`'s `check_filesystem: true`, the file metadata of your tracks on disk.
- **What it writes, and where:**
  - `--cache-dir` (default `~/Library/Caches/serato-dj-mcp`) holds a snapshot copy of your library
    database. Safe to delete at any time.
  - `--state-dir` (default `~/Library/Application Support/serato-dj-mcp`) holds staged crates, a
    manifest of every write, lock files, and backups of your library databases. Only used with
    `--allow-writes`. Deleting it deletes those backups.
  - With `--allow-writes`, `apply_changes` writes new crates into Serato's `root.sqlite`.
- **What leaves your computer is up to your MCP client.** Tool results — track titles, artists,
  crate names, file paths — go to your assistant, and from there to whichever model provider the
  client uses. Track paths under your home folder are shortened to `~`; `list_libraries`,
  `run_sql` and the backup paths returned by `apply_changes` are full paths. Check your client's
  data policy if that matters to you.

## Limitations

Read this before deciding what to trust.

- **Serato DJ 3.x is not supported.** It is recognised and reported as
  `version: "3.x"`, but nothing reads it — it stores a binary `database V2`
  rather than SQLite. No tool will return data from a 3.x library.
- **Reads go through a snapshot**, so an answer reflects the library as of the
  last snapshot, not the current instant. A snapshot is reused for up to two
  seconds, so while Serato is writing an answer can be that far behind. Only
  the current snapshot of each library is kept in `--cache-dir`; older ones
  are deleted as soon as a newer one is published.
- **Two audit checks rest on column semantics this project has not confirmed.** `stale` reads
  `is_stale` and `streaming_only` reads `third_party_type`; both were zero on every track of the
  reference library, so their counts are reported without any claim about what they mean.
- **`rating` and the streaming flag are passed through uninterpreted.** On
  the reference library `rating` was NULL or 0 on all 118 tracks (measured
  2026-09-06), so the top of the scale is unconfirmed; no meaning is claimed
  for the streaming flag either.
- **`analysis_flags` bit 2 is claimed, though the rest of the field is not.**
  It is read as "Serato ran its own analysis" — not the same as "has a BPM",
  since a BPM can come from the file's tags — and exposed as
  `flags.analyzed`, which `search_tracks` can filter on. Measured 2026-09-06
  on 118 tracks: 94 of 106 agreed with whether the track had a BPM, and the
  twelve that differed were six sound effects and six tracks whose BPM came
  from tags instead of Serato's own analysis.
- **Free-text search is not Serato's search.** Serato normalises text with a function only
  its own process has, so `q` matches both the normalised columns and the raw ones and can
  differ from what the application would find.
- **A page taken while Serato is writing can straddle two snapshots.** Pagination is keyset,
  so it continues from the same position on the newer copy and says so in
  `warnings: snapshot_advanced`; a few rows may be repeated or skipped at the seam.
- **Crate writing is new and experimental.** The write protocol was worked out against a live
  Serato DJ Lite 4.0.9 library, but it has not been exercised across Serato updates, on large
  libraries, or on libraries spread over external drives. Keep your own backups as well.
- **Writes are narrow on purpose.** `apply_changes` creates new top-level crates and nothing
  else: no nested crates, no smart crates, no renaming, reordering or deleting crates, no edits
  to tracks, cue points or other metadata.
- **A crate can only hold tracks from the library's own disk.** Streaming tracks, and tracks that
  live in another drive's Serato store, are refused by `stage_crate`, naming each one.
- **Serato must be closed to apply, and restarted to see the result.** New crates show up in
  Serato, and in this server's read tools, only after Serato has started and synced.
- **Staging reads Serato's live database.** `stage_crate` reads `root.sqlite` while Serato may be
  running. The reads are short and read-only, but their effect on a running Serato has not been
  measured yet.
- **There is no undo tool.** Undoing a write means restoring the backups by hand, as described
  above.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not open a public
issue for them.

## Contributing

Issues and pull requests are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). Changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). Maintained by [Venut Technologies](mailto:hello@venut.tech).

Serato and Serato DJ are trademarks of their respective owner. This project is independent and is
not affiliated with, endorsed by, or supported by Serato.
