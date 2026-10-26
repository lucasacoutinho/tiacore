# Differential verification

TIA must be an optimization, never a different test result. Differential
verification runs an existing TIA-enabled command selectively and then runs the
same command against a fresh full-suite plan. It compares the evidence produced
by every participating runner.

## Run the gate

```sh
npx tiacore verify --output .tia/verification.json -- npm test
```

Arguments after `--` are passed to the command unchanged. Use `--cwd` when the
command belongs to another workspace:

```sh
npx tiacore verify \
  --cwd packages/web \
  --output ../../.tia/web-verification.json \
  -- npm test
```

Programmatic callers use the same `tia()` factory:

```ts
import { tia } from '@lucasacoutinho/tiacore/verification'

const receipt = await tia({
  command: 'npm',
  arguments: ['test'],
  output: '.tia/verification.json',
}).run()

if (!receipt.success) process.exitCode = 1
```

## What is compared

Each runner records its final graph and plan in an isolated directory for each
phase. Verification requires:

- the same runner set in both phases;
- complete graphs in both phases;
- zero required tests omitted by the selective phase;
- identical test outcomes, excluding timing;
- identical test-to-file dependency evidence;
- identical reconstructed coverage topology when coverage is complete.

Coverage hit counts are reduced to covered or uncovered before comparison. Exact
counters can vary with retries, polling, and worker scheduling while producing
the same report and threshold result. Per-test shards may also vary without
changing their merged report, so the gate compares the complete per-file
reconstruction used by native coverage output. When those topologies differ,
`coverage-mismatch` includes `differences`: the first 8 triples of test file,
source file, and counter kind (`statement`, `function`, or `branch`), in
code-unit order.

The selection audit is independent of the planner's selected IDs. It derives the
required tests from the changed files and the dependency evidence in both
graphs. The selective graph preserves dependencies removed by a change; the full
graph reveals new and lazy-loaded dependencies. Structural or unexplained
changes require the full suite. Deleted test files do not select unrelated
tests. A strict verification run also treats configured unknown-file ignores as
unverified unless dependency evidence proves their scope.

The receipt distinguishes verification from command health. `verified` means
both phases agreed; `success` additionally requires both commands to exit with
status zero. Matching failures therefore prove equivalent selection without
turning a failing suite green.

The same receipt is the performance record. It includes wall time for each
phase, executed and replayed test counts per runner, execution reduction,
duration saved, measured speedup, and every selective runner that fell back to
record mode with its reason. Treat speedup as a measured value for that
repository state, not a universal package claim.

The `accuracy` section reports expected, executed, missed, and unnecessary test
counts, the false-negative rate, and selection precision. A verified receipt
always has zero missed tests and a zero false-negative rate. Unnecessary tests
reduce precision but do not fail the safety gate.

## Suite-granular runners

k6, Maestro, Gradle, and the Python and Go SDKs plan with the protocol graph and
run suites, not test cases: a k6 profile, a Maestro flow, a Gradle test class, a
pytest file, a Go package. They write the same phase snapshots, marked
`kind: "protocol"`, and the receipt calls their entries `unit: "suite"`. Every
`executedTestIds` and `missedTestIds` in such an entry is a suite id.

The k6, Maestro and Gradle runners have no CLI `run` command. Execution is the
`tia(options).run()` call from their entry points, so point `tiacore verify` at
the script that makes it:

```sh
npx tiacore verify --output .tia/verification.json -- node scripts/run-k6.mjs
```

A runner reads `TIA_VERIFICATION_DIRECTORY` and `TIA_VERIFICATION_PHASE` when
`run()` starts, before it plans or executes anything. It names itself by its
adapter and its graph file, as in `k6:.tia/k6/graph.json` or
`gradle:.tia/gradle/graph.json`, so two lanes of one command need different
`graphPath` values. The full phase sets `TIA_FRESH=1`, and these runners now
honor it like every other runner: it plans every suite.

A snapshot holds the protocol plan the runner made, the suites it executed, how
each ended, and the impact graph it would have recorded. A failed run writes its
snapshot too, although it promotes no graph. The comparison has the same guards
as for tests:

- the full phase ran every suite its plan covered, or its outcomes prove nothing
  about the suites the selective phase skipped;
- the selection audit asks the protocol planner which suites the changed files
  reach, using the observations of both phases and the strictest policy: no
  ignored change, and a changed file the graph does not know requires every
  suite. A suite that depends on another (`dependsOn`) is owed with it. A
  selective phase that fell back to a full plan owes every suite;
- outcomes agree over every suite either phase mentions. A graph is promoted
  only after every selected suite passed, so a suite the selective phase did not
  run stands for the baseline and counts as passed. The full phase decides
  whether that still holds: a suite that fails there is an `outcome-mismatch`;
- the recorded observations, and the suites with their files and `dependsOn`,
  are identical.

How a suite's outcome is known depends on the tool. k6 and Maestro run one
process per suite, so its exit status is the outcome. Gradle runs every selected
class in one invocation and reads the JUnit XML of that run: a class is failed
when one of its cases failed, passed when it reported cases and none failed, and
unknown when it reported nothing. An `unknown` outcome never agrees with
anything, so a verification that depends on one is not verified. That is the
honest answer when a failing invocation cannot be attributed to a suite.

The Python and Go SDKs read the same two variables when `run` starts and write
the same file. The Python SDK runs pytest once for all selected files. Under
`tiacore verify` it adds `--junitxml=<temporary file>` after
`command_arguments`, and when pytest exits 1 it attributes each testcase to the
file whose module name is its `classname` or a prefix of it. Every other exit
status, a failure no selected file owns (a collection error), or an unreadable
report leaves every executed file `unknown`. The Go SDK runs `go test` once and,
under `tiacore verify`, also reads the package result lines (`ok`, `FAIL`, or
the package events of `-json`) while forwarding the output unchanged. A package
that reported nothing, or reported both ways, is `unknown`. Their runner names
are `pytest:.tia/pytest/graph.json` and `go-test:.tia/go/state.json`. The Python
SDK takes its changed files from the caller. The Go SDK finds them by comparing
the project with its stored baseline. A Go run during which project files
changed writes a graph marked incomplete, so the verification reports it. The
two verification variables differ between a baseline and a verified run, so none
of these runners may let them reach its environment fingerprint, or the
selective phase would see "execution environment changed" and run everything.
The Go SDK already leaves them out of its fingerprint. If you compute the
environment fingerprint of a k6, Maestro, Gradle or Python run from the process
environment, leave them out too.

Two limits follow from how these runners work. Their change set is an input of
the caller (`changes`), so the audit measures selection against the files the
runner was told changed. It cannot know that the caller left one out. The full
phase still catches the consequence when a suite that should have run fails
there. And their graph comes from a static scan of imports and flows, so equal
dependency evidence shows the scan is stable, not that a suite touches nothing
else at run time.

## Use it during adapter development

Keep normal local and CI commands selective. Run differential verification for a
new runner, a new framework edge, or a representative changed-file matrix. For a
large repository, verify bounded lanes independently before scheduling a
periodic workspace-wide gate. The full phase sets `TIA_FRESH=1`; adapters built
on `TiaCore` inherit that behavior automatically.

Snapshots use temporary storage by default and are removed after the receipt is
created. To keep them while debugging a mismatch, pass
`tiacore verify --artifacts <dir>` or the API option `artifactsDirectory`, and
retain that directory as a CI diagnostic artifact.
