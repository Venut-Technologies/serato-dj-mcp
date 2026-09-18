# Principles

The first section is how Venut Technologies builds software; it is shared by every project. The second is what this project guarantees to its users and what it refuses to do.

<!-- venut-common-principles:start -->
## How Venut Technologies builds software

These principles apply to every Venut Technologies repository and to everyone who works in one, human or agent. They describe how we build and maintain software; what each product guarantees to its users is stated separately below them.

1. **Documentation tells the truth.** The README states what the project does, for whom, how mature it is, what is supported, and where it stops. Status, compatibility, and limitations are written from what was verified, never from what is planned. No invented adoption, metrics, or endorsements.
2. **Evidence over assumptions.** A claim that something works is backed by running it: the real command, the real environment, the real data or a faithful copy of it. A passing unit test, a mock, a simulator, or "it should work" is not evidence of production behavior. Say what was verified, how, and what was not.
3. **Boundaries are explicit.** What is supported, what is not, and what happens on the unsupported path are written down and tested. Unsupported input, platform, or state fails closed with a clear message; it never guesses, silently degrades, or pretends to succeed.
4. **Small changes with a stated intent.** One task, one branch, focused commits whose messages say why, not just what. No drive-by refactors, no unrelated fixes bundled in, no rewriting what was not asked for. When the task turns out to need more, say so before expanding it.
5. **Secrets and personal data never enter the repository.** No tokens, keys, passwords, signed URLs, or `.env` contents in code, configuration, fixtures, tests, documentation, commit messages, or agent output. No real user data, real library contents, personal file paths, or private email addresses in fixtures and examples: test data is synthetic. If something slips in, it is rotated and removed from reachable history, not just deleted in a later commit.
6. **Respect the ecosystems we touch.** Third-party software, services, formats, and trademarks are named accurately, with an explicit "not affiliated" where the name could imply otherwise. Their data is read and written only through documented or carefully verified paths, never in a way that can corrupt it or violate their terms. Their licences and attribution requirements are followed.
7. **Security issues are visible.** Every public repository has a `SECURITY.md` pointing to `security@venut.tech` for anyone who prefers to report privately. Once a problem is confirmed, it is made public promptly as an issue or advisory with its impact and status, even before a fix exists, so that users can decide for themselves. Small and experimental projects do not promise response times, and say so honestly.
8. **A person decides the irreversible.** An agent or a script does not push to a shared branch, publish a package, make a repository public, rewrite history, delete data, or deploy to a live environment on its own initiative. Each of these happens only on an explicit instruction from the owner for that specific action, and the instruction is recorded where the action is recorded.
<!-- venut-common-principles:end -->

## serato-dj-mcp principles

This server reads and writes a DJ's Serato library — the record of their music, their crates and
their work. These are the guarantees it makes about that, each one anchored in the code that
enforces it and the tests that would fail if it stopped being true.

1. **Reading never opens a Serato file for writing.** Track data is served from a snapshot: the
   live `master.sqlite` is copied with SQLite's backup API into the cache directory, checked with
   `integrity_check`, and every read tool queries that copy (`src/snapshot/index.ts`,
   `src/read/session.ts`). Two reads go to a live file, both read-only and both necessary: the
   `lock` table, because "is Serato running now" is a question about the present
   (`src/apply/serato.ts`), and `root.sqlite` while staging, because a crate must be checked
   against the file it will be written to (`src/tools/stage-crate.ts`). Covered by
   `tests/snapshot.test.ts` and by `tests/tools/stage-crate.test.ts`, which hashes `root.sqlite`
   before and after staging and fails if a byte changed.

2. **Without `--allow-writes` the server cannot write, because the write tools do not exist.**
   `stage_crate`, `preview_changes`, `apply_changes` and `discard_changes` are registered only
   behind that flag (`src/server.ts`); a tool that existed and refused would still invite the model
   to try it. `tests/server.test.ts` asserts the tool list without the flag, and
   `tests/server-writes.test.ts` asserts it with the flag.

3. **Every write is staged first, and nothing reaches the library until `apply_changes`.**
   `stage_crate` writes only a stage file in the state directory; `preview_changes` shows what is
   pending, down to each track; `discard_changes` drops it. `apply_changes` refuses without
   `confirm: true`. Proven by `tests/tools/preview-discard.test.ts` and by
   `tests/tools/apply-changes.test.ts` ("refuses without confirm: true, writing nothing").

4. **A write happens only while Serato is closed, and "closed" is established, not assumed.** The
   `lock` row survives an unclean exit, so a live process is confirmed by pid liveness plus its
   process name (`src/apply/serato.ts`); a pid that is alive but unidentifiable counts as running
   and the write is refused. The check runs before the backup and again inside the transaction,
   after the write lock is held (`src/apply/transaction.ts`). Covered by `tests/apply/serato.test.ts`
   and by the transaction test that observes the database already locked from inside the check.

5. **A batch is all or nothing, and a refusal leaves the stage intact.** Every staged crate is
   written in one `BEGIN IMMEDIATE` transaction that re-checks, inside itself, what the result
   depends on: the schema, the anchors, each crate name, and that every staged track still resolves.
   Any failure writes nothing, keeps the stage for a retry, and says which tracks were rejected
   (`src/apply/transaction.ts`, `src/tools/apply-changes.ts`). Covered by
   `tests/apply/transaction.test.ts`.

6. **No write without a backup and a record of it.** Both databases are copied before the
   transaction and the copy is verified; if the backup fails, the write does not happen. An intent
   line is written to the manifest before `BEGIN` and marked committed or aborted after, so an
   interrupted write is distinguishable from a refused one (`src/apply/backup.ts`,
   `src/apply/manifest.ts`). The write is verified before `COMMIT` and again on a fresh connection
   after; a commit that cannot be verified is reported as exactly that, with the backup paths.
   Covered by `tests/apply/backup.test.ts`, `tests/apply/manifest.test.ts` and the read-back tests
   in `tests/apply/transaction.test.ts`.

7. **Of Serato's own files, only `root.sqlite` is ever written, and only new top-level crates.**
   The server never writes `master.sqlite`, `database V2` or a `Subcrates/*.crate` file — Serato
   regenerates those itself — and never modifies or deletes an existing crate or track. Nested
   crates are not supported because Serato deletes them. What was measured about this is written
   down in [docs/serato-4x-notes.md](docs/serato-4x-notes.md).

8. **Two things that could do damage are held behind their own doors.** `run_sql` exists only with
   `--allow-raw-sql`, accepts a single `SELECT` or `WITH … SELECT`, and runs against the snapshot
   copy, never the live library (`src/tools/run-sql.ts`). And writing on Windows is unsupported: the
   running-Serato check needs `ps`, and where it cannot identify the process the server refuses to
   write rather than guessing that Serato is closed. The README states this; the refusal is covered
   by `tests/apply/serato.test.ts`.
