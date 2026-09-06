# serato-dj-mcp

MCP server for the Serato DJ 4.x library. Read-only in this build.

> Not affiliated with Serato. This project reads a reverse-engineered SQLite
> layout and can stop working after any Serato update.

## Install

```json
{
  "mcpServers": {
    "serato": { "command": "npx", "args": ["-y", "serato-dj-mcp"] }
  }
}
```

Claude Code: `claude mcp add serato -- npx -y serato-dj-mcp`

Requires Node 22.16 or newer: this server uses `backup()` from `node:sqlite`,
which was added in that version. `node:sqlite` is an experimental Node API and
prints a warning to stderr; that is expected and harmless, because the MCP
protocol travels over stdout.

## Tools

- `list_libraries` — the libraries this server can see, with version, schema
  version and locations. Paths here are not redacted, so you can copy one into
  `--library`.
- `run_sql` — one read-only `SELECT` against a snapshot copy. Registered only
  with `--allow-raw-sql`, because it returns raw rows with no path redaction.

## Options

`--library <path>`, `--root <dir>` (repeatable), `--cache-dir <dir>`,
`--state-dir <dir>`, `--allow-raw-sql`, `--allow-writes`, `--help`,
`--version`. `SERATO_LIBRARY_PATH` is an alternative to `--library`;
the flag wins. An unknown option is an error, not a no-op.

## Limitations

Read this before deciding what to trust.

- **Serato DJ 3.x is not supported.** It is recognised and reported as
  `version: "3.x"`, but nothing reads it — it stores a binary `database V2`
  rather than SQLite. No tool will return data from a 3.x library.
- **Automatic discovery only knows the macOS layout.** On Windows, always
  pass `--library` explicitly; the cache and state directories will not
  follow Windows conventions either.
- **Reads go through a snapshot**, so an answer reflects the library as of the
  last snapshot, not the current instant.
- **No write tools exist in this build.**
- **`rating`, the streaming flag and `analysis_flags` are passed through
  uninterpreted.** On the reference library `rating` was NULL on all 19
  tracks, and `analysis_flags` did not correlate with whether a track had been
  analysed, so no meaning is claimed for them.
