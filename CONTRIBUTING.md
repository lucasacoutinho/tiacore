# Contributing

Thanks for helping improve tiacore. Changes should preserve its core safety
rule: when dependency information is uncertain, expand the test run rather than
skip possibly affected tests.

## Development setup

Use Node 24 for the complete local suite. Install Bun 1.3 and Chromium
(`npx playwright install chromium`) to run the Bun and Playwright suites; they
skip without them. The differential tests compare against the published 1.2.1,
installed as the `tiacore-v1` development dependency.

```sh
npm ci
npm run gate
```

`npm run gate` verifies Oxfmt, runs Oxlint, type-checks with TypeScript 7 and
the Effect language service, runs the test suite and checks the architecture
rules. Use `npm run fmt` and `npm run lint:fix` before committing.

Useful focused commands:

```sh
npm run typecheck
npm run check:architecture
npm run check:package
npm run check:perf     # timing budgets against 1.x, one file at a time
npm run bench          # performance numbers, no pass or fail (see Benchmarks)
npm run check:proofs   # needs a Lean toolchain (elan)
npm run check:python
npm run check:go
```

Internals follow `docs/architecture/effect-conventions.md`. Public entry points
stay plain TypeScript with Promise APIs: no Effect type reaches a public
declaration file.

## Benchmarks

`npm run check:perf` only asserts two budgets against 1.x. To see where time
goes and whether a change helps, run `npm run bench`. It builds, measures, and
prints numbers; it asserts nothing and exits 0 unless a workload fails to run.

```sh
npm run bench                                   # every workload, 7 rounds
npm run bench -- --list                         # the workloads and what they time
npm run bench -- --only vitest,store            # some workloads (comma separated)
npm run bench -- --rounds 15                    # more rounds, tighter medians
npm run bench -- --save .bench/before.json      # keep the raw samples
npm run bench -- --compare .bench/before.json   # print the change against a saved run
```

Skip the build with `node --expose-gc test/perf/bench.ts ...` when `dist/` is
current. Save runs under `.bench/`, which Git ignores; never commit them. A
hill-climb is `--save` on the old tree, then `--compare` on the new one.

**Workloads.** A full run takes about four minutes. The times below are for the
default 7 rounds plus one discarded warm-up round, on a 24-core machine; they
scale with the rounds.

| Workload   | Measures                                                                                                    | Time  |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ----- |
| `cold`     | `TiaCore` prepare and commit with no stored graph, in a repository of 40 and of 400 test files              | 9 s   |
| `warm`     | prepare with a stored graph and one changed file: a second prepare in one process, a first in a new process | 13 s  |
| `vitest`   | `vitest run` of 50 files x 5 tests: no plugin, recording, and replaying one changed module                  | 57 s  |
| `effect`   | the same with `@effect/vitest` tests that fork fibers, plus the cost of the fiber tracking on 10,000 fibers | 104 s |
| `protocol` | `createImpactPlan` and graph decoding on 25,000 suites, in-process                                          | 10 s  |
| `store`    | graph store first commit, read and small commit on 5,000 tests with coverage, in-process                    | 15 s  |
| `cli`      | `tiacore --version` and `plan` on a small catalog and on 25,000 suites, in new processes                    | 34 s  |

Everything except `protocol` and `store` runs in fresh processes, because
start-up is what a user waits for. Where 1.x has the same operation, both
versions run in every round and the one that goes first alternates, so a load
spike hits both.

**Reading the output.** Each metric prints its median, minimum and MAD (median
absolute deviation) over the rounds. Metrics ending in `.v1` are 1.x, and
`.ratio` is 2.0 divided by 1.x within the same round: below 1 means 2.0 is
faster. Every metric is a cost, so lower is better.

**Noise.** `--compare` flags a metric as a WIN or a LOSS only when its median
moved by more than twice the combined noise of the two runs:
`|median now - median saved| > 2 x (MAD now + MAD saved)`. A smaller change
cannot be told from run-to-run variation and is not flagged. The rule has no
floor, so a metric with no spread at all (a process count) flags any change. Two
runs of the same tree usually differ by 2% to 5% in a median, and by up to about
15% for ratios of tiny start-up times and for the Vitest timings. Run on an
otherwise idle machine, compare runs from the same machine and Node version,
raise `--rounds` for a small effect, and repeat a surprising result.

## Change expectations

- Add a regression test that executes the real runner or framework path where
  practical. Use component tests for atomic-write, merge, parser, and explicit
  failure-injection boundaries.
- Keep the public entry points to the subpaths `package.json` exports. Do not
  import package internals in consumer examples.
- Store cache paths with project-relative forward slashes.
- Treat cache and artifact input as untrusted: validate before use and fail
  closed on incomplete, conflicting, or corrupt data.
- Do not add standalone maintenance scripts. Put executable verification in a
  test, benchmark, package command, or workflow according to its purpose.
- Update `CHANGELOG.md` and public documentation for user-visible behavior.

## Pull requests

Keep changes scoped and explain the failure mode being addressed. Before
requesting review, run `npm run gate` and `npm run check:package`. Changes to
runtime/version claims must also update the checked-in compatibility matrix.

Publishing, tagging, and dispatching a release remain maintainer-authorized
actions and are never part of an ordinary contribution.
