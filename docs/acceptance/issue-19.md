# Issue 19 acceptance

A graph recorded under Bun is not compatible with a Node.js run, and the
reverse. A runtime change records a full-suite baseline and does not replay
cached results.

## Criteria

| Item                                                                                                                                                            | Result                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bun and Node.js graphs are incompatible. A runtime change records a full-suite baseline, the same as a lockfile or config change, with no cross-runtime replay. | met                                                                                                                                                                                          |
| Tests cover the fingerprint and runtime distinction. The lifecycle regression fails on the previous fingerprint.                                                | met                                                                                                                                                                                          |
| Docs that say an environment change runs the full suite stay accurate.                                                                                          | met. `docs/guides/configuration.md` already says an environment or structural fingerprint change runs the full suite. No wording change.                                                     |
| Other adapters that share the fingerprint were checked, and only those with this bug changed.                                                                   | met. Vitest, `node:test`, `bun:test`, Playwright, and custom adapters hash `projectFingerprint`. Gradle, k6, Maestro, pytest, and Go take a caller-supplied fingerprint and were not edited. |

## Commands

Node.js v22.23.4, Linux. Exit codes:

| Command                                                                                                                                                                | Exit |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `npm run gate`                                                                                                                                                         | 0    |
| `npm run check:package`                                                                                                                                                | 0    |
| `npm run check:python`                                                                                                                                                 | 0    |
| `npm run check:go`                                                                                                                                                     | 0    |
| `npm run check:proofs`                                                                                                                                                 | 0    |
| `npm run check:perf`                                                                                                                                                   | 0    |
| `npx vitest run test/engine/core-lifecycle.test.ts -t "records a full baseline when the runtime changes"` with `src/engine/baseline/fingerprint.ts` from `origin/main` | 1    |
| `npx vitest run --reporter=verbose test/engine/baseline/fingerprint.test.ts test/engine/core-lifecycle.test.ts -t "Bun\|runtime changes\|names Bun"`                   | 0    |

`npm run gate` is fmt, lint, typecheck, the test suite, and the architecture
check. The suite reported 146 files passed, 1427 tests passed, 1 skipped.

The before-fix run received `mode: replay`, `reason: no affected test files`,
`replayedTests: 1`. The fixed run expects `mode: record`,
`reason: project structure changed`, `replayedTests: 0` in both directions, and
still replays from Bun 1.4.4 to Bun 1.9.0.

## Evidence

Headless terminal raster of those two vitest runs, not a desktop screenshot.
This repository had no acceptance screenshots directory, so the raster is
attached on the pull request and is not committed here.

## Unmet

None.
