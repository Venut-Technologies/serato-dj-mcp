## What this changes

<!-- One or two sentences: what changed and why. -->

## Checklist

- [ ] `npm test`, `npm run lint`, `npm run typecheck` and `npm run build` pass locally.
- [ ] No file of a real library, no database identifier, no real user or volume path is in the
      diff (`npx vitest run tests/repo-hygiene.test.ts` covers this).
- [ ] Comments state the fact and the measurement behind it, and point at no document that is
      not in this repository.
- [ ] Anything about how Serato behaves is either measured, with the measurement in the comment
      or in `docs/serato-4x-notes.md`, or is described as unverified.
- [ ] A change to the write path also says how it was tested against a real library copy, with
      Serato closed. (N/A if this change does not touch the write path.)
