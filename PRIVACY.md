# Privacy policy

`serato-dj-mcp` is a program that runs on your own computer. This page says what it reads, what
it writes, and what it sends anywhere. Every statement can be checked against the source code in
this repository; the file that does each thing is named in brackets.

## No network, no telemetry

- The server makes **no network requests** of any kind. There is no telemetry, no analytics, no
  crash reporting and no update check. The source contains no HTTP, socket or DNS code.
- It talks only to the MCP client that started it (Claude Desktop, Claude Code, Cursor, VS Code or
  another client), over that process's standard input and output.
- The only other program it runs is `ps`, and only to check whether Serato is running before a
  write (`src/apply/serato.ts`).

## What it reads

- Serato's library databases (`master.sqlite` and `root.sqlite` in the Serato library folder, by
  default `~/Library/Application Support/Serato/Library`, and `_Serato_/Library` on drives mounted
  under `/Volumes`) (`src/discovery/index.ts`).
  Reads go through a snapshot copy; the live files are opened read-only, except when
  `apply_changes` writes a crate (`src/snapshot/index.ts`, `src/read/session.ts`).
- With `audit_library`'s `check_filesystem: true`, whether each track's file exists on disk, to
  find missing files; the files themselves are not opened (`src/read/audit.ts`).

It does not read your audio, and nothing outside the Serato library and the two directories below.

## What it writes, and where

- **Cache directory** (`--cache-dir`, default `~/Library/Caches/serato-dj-mcp`): a snapshot copy of
  your library database. Safe to delete at any time (`src/snapshot/index.ts`).
- **State directory** (`--state-dir`, default `~/Library/Application Support/serato-dj-mcp`), only
  with `--allow-writes`: staged crates, a manifest of every write, lock files, and backups of your
  library databases taken before each write, the last ten kept (`src/stage/store.ts`,
  `src/apply/manifest.ts`, `src/apply/backup.ts`).
- **Serato's `root.sqlite`**, only with `--allow-writes` and only when `apply_changes` is called with
  `confirm: true` while Serato is closed: new top-level crates, nothing else
  (`src/apply/transaction.ts`).

Everything above stays on your computer.

## What your AI assistant sees

Tool results, such as track titles, artists, crate names and file paths, go to your MCP client,
and from there to whichever AI model provider that client uses. That transfer is done by the
client, under the client's and the provider's own privacy terms, not by this server. Paths under
your home folder are shortened to `~` in most results; `list_libraries`, `run_sql` (only with
`--allow-raw-sql`) and the backup paths returned by `apply_changes` show full paths.

## Contact

Questions about this policy: open an issue at
https://github.com/Venut-Technologies/serato-dj-mcp/issues, or write to hello@venut.tech.
Security reports: see [SECURITY.md](SECURITY.md).
