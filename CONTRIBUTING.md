# Contributing

Thanks for helping. This project touches people's DJ libraries, so the rules below lean towards
caution.

## Before you start

- For anything bigger than a small fix, open an issue first and describe what you want to change.
- Security problems go to security@venut.tech, never to a public issue — see
  [SECURITY.md](SECURITY.md).
- Serato is a third-party product. This project is not affiliated with Serato; do not add
  Serato's code, binaries, artwork or proprietary documentation.

## Setup

Requires Node.js 22.16 or newer.

```sh
npm ci
npm run lint        # Biome, warnings are errors
npm run typecheck   # tsc over src and tests
npm test            # vitest
npm run build       # emits dist/
```

All four must pass before a pull request is reviewed. CI runs lint and tests on macOS and Linux,
and the build, typecheck and package check on Linux.

## Never commit library data

- Do not commit real Serato databases (`master.sqlite`, `root.sqlite`, `location.sqlite`,
  `database V2`), crate files, logs, or anything copied out of a real library — including track
  titles, file paths and user names.
- Tests build their libraries from synthetic fixtures in `tests/fixtures/`. Add what you need
  there, with invented data.
- `.local-fixtures/` is ignored by git on purpose. Keep private experiments there.

## Code

- TypeScript, ES modules, `.js` suffixes in imports.
- Errors are values: tools return an error object with a code and details, they do not throw.
  The codes are listed in `src/errors.ts`.
- Every model-supplied list must be bounded, and every query on a write path must use an index:
  this server is synchronous, so a slow query blocks every other call.
- Write tests first where you can. A test should fail if the rule it names is removed.
- Keep comments about *why*, and date any claim that comes from measuring a real library.

### Changes that write to the library

Anything that can modify Serato's files needs extra care:

- it must stay behind `--allow-writes`;
- it must keep the order in `apply_changes`: lock, pre-checks, backup, manifest intent,
  transaction, verification;
- it needs tests for the failure paths, not only for success;
- say in the pull request how you verified it, and on what Serato version.

## Pull requests

- One topic per pull request, with a description of what changed and why.
- Update `README.md` when behaviour, flags or limitations change, and add an entry under
  *Unreleased* in `CHANGELOG.md`.
- Commit messages: an imperative subject line that says what the change does.

## Releasing (maintainers)

1. Make sure `main` is green in CI.
2. Move the *Unreleased* entries in `CHANGELOG.md` under the new version and date.
3. Bump `version` in `package.json`.
4. Check the tarball: `npm pack --dry-run` should list `dist/`, `README.md`, `LICENSE` and
   `package.json` only.
5. Tag the release, publish to npm, and create the GitHub release from the changelog entry.
