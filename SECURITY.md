# Security Policy

## Reporting a vulnerability

Please report security problems privately, by email to **security@venut.tech**. Do not open a
public GitHub issue, pull request or discussion for them.

Useful things to include:

- what you found and why it is a security problem;
- the version or commit, your operating system, Node.js version and Serato DJ version;
- the MCP client you used and the server flags (`--allow-writes`, `--allow-raw-sql`);
- steps to reproduce, ideally against a throwaway or synthetic library rather than your own.

Please do **not** send us your real Serato library, database files or track paths. If a
reproduction needs a library, describe its shape instead, and we will build a synthetic one.

We read every report and will reply once we have looked at it. This is a small open-source
project maintained on a best-effort basis: there is no guaranteed response or fix time. We will
keep you informed while a fix is being worked on, and credit you in the release notes if you wish.

## Supported versions

The project is pre-1.0. Security fixes are made on the latest version only.

## What counts

This server runs locally, reads a Serato DJ library, and — with `--allow-writes` — writes crates
into it. Examples of issues we want to hear about:

- any way for a tool call to write to, delete or corrupt library files without `--allow-writes`,
  or beyond what the documented write tools do;
- `run_sql` executing anything other than a read-only query;
- a write that bypasses the backup, or leaves the library in a state the README's restore
  procedure cannot recover;
- reading or disclosing files outside the Serato library, cache and state directories;
- anything that makes the server reach the network.

Problems in your MCP client, in the model provider it talks to, or in Serato itself are out of
scope for this project; please report those to their maintainers.
