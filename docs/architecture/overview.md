# Architecture

tiacore selects the tests a change can affect and replays cached results for the
rest. When the evidence for a decision is uncertain, it runs more tests, never
fewer. This page describes how the package is built. The rules for writing code
in it are in [Effect conventions](effect-conventions.md).

## Layers

`src/` is split into layers. Each layer may import only the layers listed for it
in the conventions, and `archer.config.ts` enforces that.

- `core` holds the pure decisions: path normalization, test selection, replay,
  partition merge, the verification verdict and the public types. It uses no
  Effect and no Node built-ins, so it can be modeled in Lean.
- `probe` runs inside test workers. It turns coverage counters into per-test
  windows with plain TypeScript, because it runs on every test.
- `evidence` is a small SDK that application code uses to report dependencies
  across processes, for example from a server under Playwright.
- `wire` holds the Effect Schemas, decoders and the four tagged errors.
- `host` runs Effect programs for the Promise-based public API and carries the
  observability layers (devtools, OTLP, trace and metrics files, crash reports).
  A process has one host runtime.
- `engine` is the Effect shell around `core`: the graph store, baselines,
  planning, coverage, framework edges, artifacts and scheduling.
- `runners` has one directory per runner: Vitest, Playwright, Node, Bun, the
  TypeScript adapter kit, k6, Gradle and Maestro.
- `assurance` holds differential verification, adapter certification and the
  workspace orchestrator.
- `cli` is the `tiacore` command, built on Effect's CLI module.
- `entries` has one thin file per `package.json` export.

Effect is internal. Public entry points take and return plain values, Promises
and interfaces, and no Effect type reaches a public declaration file.

## A run

1. **Prepare.** The runner reads the stored graph, captures a baseline (the git
   commit plus a hash of every changed file, or a filesystem snapshot outside
   git) and computes a structural fingerprint from configuration and lockfiles.
   If a configured artifact source has a better graph, it is restored first.
2. **Plan.** `core` compares the change set with the graph's dependency edges. A
   test runs when a file it depends on changed, when it failed last time, or
   when its file changed. A change the graph does not know, a structural file or
   an incompatible fingerprint makes the run a full run.
3. **Run.** The runner executes the selected tests and replays the cached
   results of the others into the runner's own reporting.
4. **Record.** Each executed test reports the files it touched, from coverage
   windows, module graphs, framework edges or evidence events. When a test's
   evidence is incomplete, the run commits nothing.
5. **Commit.** The new observations fold into the graph. A file whose every test
   ran replaces its evidence. A file with replayed tests keeps the evidence
   those tests had. The commit holds a cross-process lock and merges with a
   concurrent writer when their changes do not overlap.

## The graph store

The graph lives in `.tia/` as a small manifest, `state.json`, and
content-addressed objects under `objects/`. Each record family (results, test
edges, file edges, coverage, collection files and the working-tree list) is
split into 64 stable key buckets. Each bucket is one object named by its
SHA-256, so a small update rewrites only the buckets it touches. A bucket holds
at most 20 MiB.

Readers check the manifest's generation and every object's size, digest and
entry count. Anything missing, corrupt or inconsistent reads as no graph, and
the next run is a full run. Unreferenced objects stay for 24 hours so a reader
of the previous manifest never loses an object to a concurrent commit.

Coverage stores each file's static Istanbul maps once, keyed by a digest of the
map, and each test keeps only the counters it advanced. Stored size therefore
grows with the counters tests touch, not with tests times source size.

## Portability

Other languages integrate through a versioned protocol, not a shared binary. The
impact graph format, its JSON Schemas and the planning rules are specified in
`spec/` and `schemas/`, and `conformance/` holds vectors every implementation
must reproduce. The Python and Go SDKs in `sdks/` pass them, and
`tiacore certify` checks an adapter against the kit. JavaScript-only data, such
as coverage counters, stays out of the portable graph.

## Correctness

- The selection kernel, replay, coverage windows, partition merge, the
  verification verdict, path normalization and the graph update are modeled in
  Lean in `proofs/`. A Lean executable that evaluates the selection model checks
  the TypeScript selection against the conformance vectors and a fuzz run
  (`npm run check:proofs`). Every theorem is audited for axioms beyond Lean's
  standard three.
- Differential tests compare 2.0 with the published 1.2.1 wherever behavior is
  meant to match.
- `tiacore verify` checks a real project: it runs a selective and a full run and
  fails when the selective run missed a test the full run shows it needed.
