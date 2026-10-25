# ADR 0004: tiacore 2.0 on Effect

Status: accepted

## Context

tiacore 1.x grew to about 16,000 lines in 115 files across 20 directories, with
two selection planners, hand-rolled validation, commander-based CLI wiring, and
I/O mixed into decision code. The owner asked for a rewrite on Effect 4 with
TypeScript 7, `@effect/tsgo` and `@effect/vitest`, internals developed with Lean
Driven Development, built-in performance and leak diagnostics, and no lost
capability. Users keep a plain TypeScript surface.

Four designs were produced in parallel under different constraints (minimal
interface, maximum flexibility, common caller and performance, ports and
adapters with a Lean core). This record keeps the hybrid that was chosen. The
1.x tree lives in `.legacy/` as the differential oracle and performance
baseline, and a capability inventory (1,796 rows, each with its 1.x tests) is
the acceptance contract.

## Decision

The hybrid takes the pure, Lean-modelled core from the ports design, the
performance rules and worker probe from the common-caller design, the seam
discipline and module count from the minimal design, and one rule from the
flexible design: no Effect value crosses a public seam, because Effect is
bundled and a caller's Effect copy would not share context keys with it.

## Module map (7 modules)

```
entries/*  (16 public subpaths, thin shims; dynamic import of heavy chunks)
   |
cli (runCli argv -> exit code)        host (bridge: ManagedRuntime -> Promise; observe layers)
   |                                     |
assurance (verify, certify, workspace run)
   |
runners/* (vitest playwright node bun gradle k6 maestro + adapter)
   |
engine (Effect shell: prepare/plan, record/commit, replay, store, baseline, artifacts, edges, coverage report)
   |
wire (Effect Schemas, tagged errors, JSON Schema generation)
   |
core (pure TS, no Effect, no node:): select, gate, window, merge, replay, trust/promote, verdict, path, canonical order
probe (pure TS, no Effect, no node:): worker coverage ledger; imports core only
evidence (plain TS leaf; AsyncLocalStorage + files; imports nothing tiacore)
```

Dependency rule: each layer imports only layers below it; `core`, `probe`,
`evidence` import no `effect`; worker chunks (`probe`, vitest `setup`) import no
`effect` and no `node:` (browser mode). archer enforces this; a bundle test
asserts it on the built chunks; a d.ts test asserts no public declaration
imports `effect`.

## Seams (only those with two real adapters)

| Seam               | Adapters                                                                               |
| ------------------ | -------------------------------------------------------------------------------------- |
| `ArtifactStore`    | filesystem, GitHub Actions, GitLab CI, HTTP manifest, user `put()` sink                |
| `CoverageSource`   | Istanbul `__coverage__`, V8/native (`TIA_COVERAGE_MODE=native`), Playwright CDP ranges |
| `Runner`           | 7 native runners + `tia(definition)`                                                   |
| `Baseline` (`Vcs`) | git, filesystem snapshot (legacy `Baseline.source 'filesystem'`, Go/Python SDKs)       |

Everything else uses Effect built-ins directly: `FileSystem`, `Path` (through
`node:path` where Effect's posix-only `Path.layer` would be wrong on Windows),
`ChildProcessSpawner` (`effect/process`), `Clock`, `Scope`. Tests substitute the
built-in layers. picomatch and tinyglobby stay (Effect has no glob;
`FileSystem.glob` needs Node 22 `fs.glob`), wrapped by one `glob` module so the
dialect is pinned in one place.

## Effect wiring and runtimes

| Process                                                 | Runtime                                                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                                                     | one `ManagedRuntime` per invocation, built per command group; `--version`/`--help` fast path loads no Effect; `runPromiseExit`, dispose in `finally` |
| Vitest main                                             | one lazily created runtime per Vitest instance (keyed like legacy `sharedStates`), disposed on `onTestRunEnd` + `onClose`; leak test proves it       |
| Vitest worker, browser                                  | **no Effect**: `probe` + plain setup (overrides plan decision 9; d1/d3 measurements)                                                                 |
| Playwright reporter, node/bun/gradle/k6/maestro `run()` | one runtime per run, disposed in `finally`                                                                                                           |
| Promise library functions                               | pure ones call `core` directly; effectful ones go through `host.bridge`                                                                              |

Errors: `Schema.TaggedError` classes (Effect 4.0.6 name) grouped as `Invalid`,
`Io`, `Untrusted`, `Failed`. `Match.tagsExhaustive` maps them to exit codes (all
1, matching 1.x) and to thrown `TiaError extends Error` with the 1.x message
text at the Promise seam. Defects stay defects.

## Schema

All wire types are Effect Schemas with built-in checks; regex only where no
built-in fits, always with the `u` flag (without it `pattern` is silently
dropped from JSON Schema, `Schema.ts:6908`). Decode at trust seams only
(artifact restore, `--graph` input, SDK interchange, config); the engine's own
store uses `JSON.parse` + schema version + content hash, rebuilding on any
mismatch. `schemas/*.json` are generated by
`toJsonSchemaDocument(S, { onExcessProperty: "error" })` + a post-processor;
target byte-equality, fallback one reviewed diff gated on identical
accept/reject over `conformance/**`. `Match` for classification at
file/edge/error granularity; plain `switch` inside per-counter loops (2 ns vs 20
ns).

## Vitest adapter

Proven in 1.2.1: dual `TaskMeta` augmentation (`@vitest/runner` for 4, `vitest`
for 5); `fsModuleCache`/`sharedViteServer` off unless set. New in 2.0:
hook-marker attribution windows (pre/post body coverage becomes collection
coverage; d4 `conservation` theorem), `exact:false` fallback for unsplittable
windows (`sound_groups`), graph schema version bump, typed-array probe,
counters-only per-test payload with static maps once per file. Nothing
Effect-specific ships; an `@effect/vitest` fixture (`it.effect`, `it.live`,
`layer()` both forms, a `forkDetach` case) is proven by `tiacore verify`. Peer
`vitest >=4.1 <6`.

## Observability, performance, leaks

- `observe(env)` returns `Layer.empty` unless `TIACORE_DEVTOOLS=ws://...`
  (`effect/devtools`), `TIACORE_OTLP_URL`, or `TIACORE_PROMETHEUS_PORT` is set;
  exporter chunks load by dynamic import. `stage(name)` is identity when off.
- Spans per stage only; metrics per module/run: heap, graph size, window
  duration, RPC payload bytes, plan size, store bytes.
- `tiacore devtools` hosts `DevToolsServer`; `tiacore doctor --perf` prints the
  last run's stage timings from a local trace file (`.tia/trace.json`) so a user
  can report bottlenecks without a devtools UI.
- Crash capture: unhandled defects write `.tia/crash-<ts>.json` (Cause pretty
  print + stage + versions) and print its path.
- Budgets (CI-enforced, relative to `.legacy` on the same runner): `--version`
  and `plan` startup <= legacy; protocol-scale planning <= legacy; per-test
  worker overhead <= legacy; parallelism benchmark within noise.
- Leak harness `leakTest(op, n)`: `--expose-gc`, warm-up, n iterations, assert
  retained heap slope ~0. Cases: each past leak (per-test map payload,
  NF-MEM-01), runtime make/dispose, graph load/save, plan, replay, artifact
  restore, Vitest main across 50 reruns in watch-like loop, Playwright reporter.

## LDD scope

`core` is the LDD module. Start from d4's Lean project (copied into `proofs/`),
keep its 27 theorems, add `MonotoneInChanges` and order-independence before
shipping. Executable Lean model `tia-ref` emits vectors into `conformance/` for
select, gate, verdict, trust, path; TS, Python and Go run them. Formal TS<->Lean
correspondence remains a visible open obligation; differential tests compare the
indexed TS kernel to `tia-ref` on random problems. CI runs `lake build`, checks
`#print axioms`, and fails on vector regeneration diffs.

## Behaviour decisions

Rule: keep every capability; where 1.x behaviour is unsafe or contradicts its
own spec, 2.0 takes the sound/fail-closed side and lists it in the CHANGELOG.
Owner may reverse any line.

| Id                                                                          | 1.x                                                                                                                | 2.0                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| ENV-FRESH-01..03                                                            | `TIA_FRESH` parsed three ways                                                                                      | one parser: `1/true/yes/on` (case-insensitive) everywhere incl. Go/Python                                              |
| VERIFY-RUN-04                                                               | inherited `TIA_FRESH` leaks into selective phase                                                                   | verifier clears it for the selective phase                                                                             |
| ART-RESTORE-07/08                                                           | restore alone defaults `allowUnsigned:true`                                                                        | unsigned rejected unless explicitly allowed, at every layer (matches spec)                                             |
| PROTO-GRAPH-17, STATE-DET-02                                                | locale-dependent ordering                                                                                          | UTF-16 code-unit ordering everywhere (digests change once; graph schema bump)                                          |
| PROTO-PATH-04                                                               | `a` and `a/` distinct                                                                                              | trailing slash normalized away                                                                                         |
| PLAN-PROTO-27                                                               | dependency closure escapes `allowedSuites`                                                                         | closure restricted to allowed suites; disallowed dependents reported                                                   |
| runtime planner `__tests__`                                                 | false negative                                                                                                     | fixed (kernel subsumes both planners)                                                                                  |
| REPLAY-DELETED                                                              | linked deleted test files listed as whole-file fallbacks; unlinked ones still replayed                             | results of test files that no longer exist are neither replayed nor counted                                            |
| COV-REINSTRUMENT                                                            | a file re-instrumented mid-run (new `__coverage__` object) was clamped against the old counters, losing increments | the probe counts the new object's counters from zero                                                                   |
| CERT-SCHEMA                                                                 | the certification JSON Schema is looser than the receipt parser                                                    | unchanged: the decoder keeps the parser's strictness; the published schema stays as is                                 |
| CERT-SPEC                                                                   | `certify execute --spec` was cast without validation                                                               | the spec is decoded; a malformed spec fails at once                                                                    |
| STATE-GC-02                                                                 | an unreferenced object older than 24 h was deleted even when just reused                                           | reuse refreshes the object's mtime; objects live 24 h after their last reference                                       |
| STATE-MERGE-04                                                              | a fragment index above `total` made the merge return null                                                          | indexes outside 1..total are skipped, as in proofs/Tia/Merge.lean; `total < 1` is rejected                             |
| STATE-TXN-06                                                                | a stale lock was removed and recreated, racing other waiters                                                       | the stale lock is renamed away and its owner token checked; a live lock moved by mistake is restored                   |
| STATE-TXN-08                                                                | a committed result returned a deep clone of the graph                                                              | it returns the caller's graph, saving a full clone per commit                                                          |
| BASE-CAP-10                                                                 | a FIFO in the project blocked the baseline read                                                                    | directories, FIFOs and sockets hash as unavailable; files of 2 GiB or more are refused by size                         |
| SCHED-EXEC-06                                                               | a failing or interrupted external-suite run left running children behind                                           | running children are stopped when the run fails or is interrupted                                                      |
| K6-PROMOTE                                                                  | a successful run with an unlexable profile threw without writing a graph                                           | it writes a `complete:false` graph so the next run is full                                                             |
| MAESTRO-CONFIG                                                              | `config.yaml` anywhere was excluded by tag only                                                                    | `config.yaml`/`config.yml` are excluded at the flows root; nested ones stay suites                                     |
| GRAPH-OPTIONS                                                               | `record --graph-options` invalidators and observations were trusted                                                | they are decoded with the protocol schemas; unknown keys are still ignored                                             |
| NODE-AGG-02                                                                 | Node aggregate mode fail-open                                                                                      | fail closed (no graph commit on module failure/timeout)                                                                |
| NODE-EXEC-06, WS-CFG-03, NODE-SHIM-06                                       | CJS entry broken paths                                                                                             | moot: no CJS build; `require(esm)` path tested                                                                         |
| NODE-PAR-03, WS-SCHED-01                                                    | `NaN` concurrency drops work / unbounded                                                                           | rejected at config decode                                                                                              |
| BUN-FAIL-04                                                                 | describe/skip/todo cases become module failures                                                                    | kept fail-closed; documented                                                                                           |
| GRADLE-RUN-09                                                               | stale result XML satisfies completeness                                                                            | results older than run start rejected                                                                                  |
| MAESTRO transitive                                                          | only direct parents                                                                                                | transitive closure (matches README)                                                                                    |
| MAESTRO-DISC-03                                                             | single-doc YAML never scanned; config.yaml a suite                                                                 | scan all docs; `config.yaml` excluded                                                                                  |
| K6-IMP-04/05                                                                | type-only edges; unlexable file throws after run                                                                   | type-only imports ignored; lex failure -> full run before execution                                                    |
| PW-RUN-10                                                                   | filters dropped above 24k chars                                                                                    | fall back to full run with reason                                                                                      |
| PW-RUN-19/20                                                                | plain `test` / out-of-root spec blocks every commit                                                                | kept (fail-closed); reason surfaced in `doctor`                                                                        |
| COV-THR-06                                                                  | threshold glob matching no files passes                                                                            | fails with a clear error                                                                                               |
| STATE-LIMIT-02 (store v3)                                                   | ~10k dirty files throw                                                                                             | working-tree list stored as a separate object; no fixed cap                                                            |
| BASE-CAP-09                                                                 | baseline null for symlinks/nested repos/submodules/2 GiB                                                           | kept fail-safe; reason surfaced                                                                                        |
| CLI-WIRE-11                                                                 | commander quirks (double usage errors, `(outputHelp)`)                                                             | not ported; help text outside contract                                                                                 |
| Python/Go SDK bugs (P2, `build`/`dist` paths, root package, no `dependsOn`) |                                                                                                                    | fixed, verified by shared vectors                                                                                      |
| SDK planners (Python, Go)                                                   | reasons, check order and glob dialect differed from the TypeScript planner                                         | one behaviour: both SDKs reproduce every protocol vector, TS reasons verbatim; globs are a documented picomatch subset |
| dead code (8.3)                                                             |                                                                                                                    | not ported                                                                                                             |

## Versioning and compatibility

2.0.0. ESM only (Effect is ESM-only); `require()` works on Node >=22.12 via
`require(esm)` and is tested. Engines `^22.12 || >=24` (Node 20 EOL; Vitest 5
needs 22.12). `vitest >=4.1 <6`, `vite >=6 <9`, `@playwright/test >=1.46 <2`.
Effect is bundled (esbuild, ESM, code-split shared chunk, minified); consumers
install no Effect. Help text is outside the CLI contract; commands, flags, exit
codes, stdout/stderr formats and JSON outputs are inside.

## Migration slices

0. `.legacy/` move; legacy builds/tests in place; benchmark baseline captured.
1. Toolchain: TS 7.0.2 + @effect/tsgo + effect 4.0.6 + @effect/vitest + vitest
   5 + esbuild + oxlint/oxfmt + archer (override); stub every export;
   publint/attw; bundle/d.ts/worker-chunk tests; legacy differential harness.
2. `core` + Lean + vectors (oracles: legacy protocol/plan tests, conformance).
3. `wire` + JSON Schema generation + gate.
4. `engine` store/baseline/plan/replay/commit (oracles: legacy engine tests).
5. `probe` + Vitest runner + attribution windows + @effect/vitest fixture.
6. Remaining runners; artifacts; edges; coverage report.
7. `assurance` (verify/certify/workspace) + `cli`.
8. `host` observability, crash capture, leak tests, perf budgets vs legacy.
9. Inventory sweep: every row's legacy tests ported or replaced; UNTESTED-H rows
   (8.5) get new tests; SDK fixes; docs.
