# Working agreements

## Before every commit: run the CI gates locally

CI (`.github/workflows/ci.yml`) is the merge gate, and a red pipeline blocks merge. Never commit
without at least the formatting step below — a formatting-only CI failure has already cost a build.

```sh
pnpm format:write   # ALWAYS: rewrites files to Prettier style. CI runs `pnpm format`
                    # (`prettier --check .`), which FAILS on any unformatted file.
pnpm typecheck
pnpm lint
pnpm test:unit
```

`pnpm format:write` must be run **after** the last edit of a change — including edits made while
fixing typecheck, lint, or test failures — and the reformatted files must be included in the commit.

The remaining CI steps (`test:contract`, `test:integration` under the Firestore emulator,
`test:determinism`, `build`) are worth running before pushing anything that touches their areas.
