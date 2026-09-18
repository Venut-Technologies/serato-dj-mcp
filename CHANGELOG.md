# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, a minor version may contain breaking
changes.

## [Unreleased]

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
