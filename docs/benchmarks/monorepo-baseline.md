# Monorepo benchmark baseline

tiacore's primary acceptance target is a large private TypeScript monorepo with
Vitest, React Testing Library, Playwright, k6, Maestro, and Android build and
device lanes. Synthetic fixtures remain useful for failure injection, but
performance claims are qualified here against real suites.

## 2026-07-31 baseline

The run used an isolated Git worktree on Linux, Bun 1.3.14, Vitest 4.1.10,
Playwright 1.62, Chromium, and a tiacore 1.0 candidate.

| Lane                     |       Selective |        Fresh full | Executed reduction | Wall-time speedup |
| ------------------------ | --------------: | ----------------: | -----------------: | ----------------: |
| Workspace Vitest package |  1.52s, 7 cases | 17.39s, 173 cases |             95.95% |            11.47x |
| Playwright green smoke   | 36.31s, 2 cases |   55.56s, 4 cases |                50% |             1.53x |

Both receipts passed differential verification: outcomes, runtime dependency
edges, and complete reconstructed coverage agreed. Neither selective phase fell
back to record mode.

The Playwright number includes dev-server startup in both phases. It shows why
test selection and server reuse are separate optimization axes: halving browser
cases saved 19.25 seconds, but the bundle/server startup still dominates the
selective run.

## Method

Use the real suite commands through `tiacore verify`; do not maintain a second
benchmark runner. Establish a full baseline, make one controlled no-behavior
source edit, and save the JSON receipt outside source control:

```sh
tiacore verify \
  --output .tia/verification/vitest-performance.json \
  -- bun run --filter <workspace-package> test
```

The Playwright acceptance subset excludes a known-failing product assertion
while retaining four real Chromium smoke cases across three spec files:

```sh
tiacore verify \
  --output .tia/verification/playwright-green-performance.json \
  -- <playwright-launcher> --grep-invert "<known-failing test>"
```

For the recorded run, the Vitest stimulus touched a planner source file and the
Playwright stimulus touched one UI spec. The Playwright lane ignored unrelated
test infrastructure, native, load-test, workflow, and registry paths. Keep those
lane boundaries in the benchmark configuration so unrelated test infrastructure
does not turn a UI measurement into a full fallback.

Wall time varies with host load and cold bundling. Compare executed reduction
first, then use several receipts for performance regression decisions. A release
claim must include the repository revision, suite command, runtime versions,
phase metrics, fallbacks, and the unedited receipt.

## Planner scale guard

`npm run benchmark:parallel` uses Vitest Bench for both parallel-runner and
planner measurements; tiacore does not maintain a custom benchmark harness. The
planner case contains 10,000 suites and 20,000 observations. The normal
integration suite also exercises a deterministic 25,000-suite graph as a
correctness regression gate, while wall-clock benchmark history remains a
performance signal rather than a brittle release threshold.
