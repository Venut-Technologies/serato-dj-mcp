## What this changes

<!-- One or two sentences: what changed and why. -->

## Checklist

- [ ] `npm test`, `npm run lint`, `npm run typecheck` and `npm run build` pass locally.
- [ ] I checked myself: no file of a real library (a `.sqlite`, `.sqlite-wal`/`-shm` or `.crate`
      file) is in the diff. `tests/repo-hygiene.test.ts` cannot see this — it skips any file with
      a NUL byte, and a real library file is binary.
- [ ] No whole database identifier (32+ hex characters, bare or as a SQLite blob literal), real
      user name or real volume name is in the diff, as text (`npx vitest run
      tests/repo-hygiene.test.ts` covers this). It does not catch a shorter fragment of an
      identifier -- check that yourself.
- [ ] Comments state the fact and the measurement behind it, and point at no document that is
      not in this repository.
- [ ] Anything about how Serato behaves is either measured, with the measurement in the comment
      or in `docs/serato-4x-notes.md`, or is described as unverified.
- [ ] A change to the write path also says how it was tested against a real library copy, with
      Serato closed. (N/A if this change does not touch the write path.)
