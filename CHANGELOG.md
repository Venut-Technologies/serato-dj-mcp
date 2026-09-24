# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may contain breaking
changes.

## [Unreleased]

### Added

- A Claude Desktop extension (`.mcpb`), attached to each GitHub Release from this version on and
  listed in the MCP Registry: install it by opening the file, no Node.js needed. Its settings are
  the library folder (optional), "Allow writing crates" and "Allow raw SQL", both off by default.
  macOS only ([a9ba003]).
- Each release is now published to the official MCP Registry as well as npm, as
  `io.github.Venut-Technologies/serato-dj-mcp` (the new `mcpName` in `package.json`), so MCP
  clients and catalogs that read the registry can find and install the server ([c296ac9],
  [5ed9177], [06019b9]).
- A Claude Code plugin (`.claude-plugin/plugin.json` and `.mcp.json`) that starts the server with
  `npx -y serato-dj-mcp`, read-only ([0f73224]).
- [PRIVACY.md](PRIVACY.md): what the server reads, what it writes and where, and that it makes no
  network requests and sends no telemetry, with the source file behind each statement
  ([4a9783e]).

### Changed

- The README starts with what a DJ can do and ask, and installs from npm with `npx`: it said the
  package was not on npm yet, which was also what the npm page showed. It now has setup steps for
  Claude Desktop (extension or config), Claude Code, Cursor and VS Code, with install links for
  the last two, and says which of them were tried and that Windows is untested ([75c6af1]).
- The package description says what the server does for a DJ, including that it writes new
  crates after a preview, instead of only "staging" them ([c296ac9]).
- Every tool now states all four MCP hints and `openWorldHint: false`, with its title repeated
  inside `annotations`. `apply_changes` is now marked destructive: it only adds crates, but it
  writes into Serato's own database, rotates old backups out and has no undo tool, so a client
  that asks before destructive calls will ask before this one. `discard_changes` is marked
  idempotent ([60c957f]).

### Fixed

- In Claude Desktop, every tool answered with a one-line count ("crates: 3") and no data: results
  travelled only as structured content, which Claude Desktop does not pass to the model. Results
  now also travel as compact JSON text, as the MCP specification recommends, so Claude Desktop
  sees the tracks and crates themselves ([aca9ee5]).

## [0.1.0] - 2026-09-19

The first release: reading, auditing and — behind a flag — crate writing.

### Added

- Local MCP server for Serato DJ 4.x libraries, reading through a snapshot copy of the library
  database so a query never changes the library ([fb8c0a0]).
- `list_libraries`: the libraries the server can see, with version, schema version and locations.
- `search_tracks`: free text, BPM range or BPM around a value, Camelot key or harmonically
  compatible keys, genre, rating, date added, crate membership and flags; keyset pagination.
- `get_tracks` and `get_crate_tracks`: tracks by id, and the tracks of a crate in its own order.
- `list_crates`: the crates of the Serato Library space with their display paths and track counts.
- `audit_library`: tracks with no BPM, no key or an unreadable key, stale, in no crate,
  streaming-only, duplicated, or with broken paths, with an opt-in check against the disk
  ([589c6cb]).
- `run_sql` behind `--allow-raw-sql`: one read-only `SELECT` against the snapshot.
- Crate writing behind `--allow-writes`: `stage_crate`, `preview_changes`, `discard_changes` and
  `apply_changes`. Crates are staged first and applied only with Serato closed, all or nothing,
  after a backup of both library databases and with a manifest of every write ([4031b37]).

[Unreleased]: https://github.com/Venut-Technologies/serato-dj-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Venut-Technologies/serato-dj-mcp/releases/tag/v0.1.0
[fb8c0a0]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/fb8c0a0
[589c6cb]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/589c6cb
[4031b37]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/4031b37
[60c957f]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/60c957f
[c296ac9]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/c296ac9
[5ed9177]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/5ed9177
[06019b9]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/06019b9
[4a9783e]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/4a9783e
[0f73224]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/0f73224
[aca9ee5]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/aca9ee5
[a9ba003]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/a9ba003
[75c6af1]: https://github.com/Venut-Technologies/serato-dj-mcp/commit/75c6af1
