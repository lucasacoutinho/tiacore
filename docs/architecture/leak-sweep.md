# Leak sweep

tiacore 1.x leaked. A long-lived process, such as a watch loop, an editor
integration or a CI agent, grew without bound. This page lists every long-lived
resource in `src/` and the test that proves it does not grow.

`assertNoLeak` (`test/support/leak.ts`) runs an operation in batches after a
warm-up. It forces garbage collection, then fails when:

- retained heap grows by more than `bytesPerOperation` per operation;
- active handles (timers, sockets, child processes) grow by more than three;
- open file descriptors grow by more than three.

A test may pass `handles: false` when a resource closes on its own timer, such
as a keep-alive socket. That test then waits for the handle count to fall back
(`waitForHandles`). Each test has been checked against a deliberate leak:
`test/host/leaks.test.ts` proves that the check fails on timers and file
descriptors that are never released.

## Resources

| Resource                                                                       | Bound or disposal                                                                                                       | Test                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Process-wide `ManagedRuntime` (`host/runtime.ts`)                              | Built on first use. `disposeHost()` releases it. A runtime that holds exporters closes itself 0.5 s after its last run. | `test/host/runtime.test.ts`, `test/host/leaks.test.ts` (build and dispose cycles), `test/host/idle.test.ts` |
| Span recorder (`recordSpans`)                                                  | Restores the previous recorder in `finally`.                                                                            | `test/host/leaks.test.ts`                                                                                   |
| Recording tracer buffer (`host/observe.ts`)                                    | Newest 10,000 spans.                                                                                                    | `test/host/observe.test.ts`                                                                                 |
| Trace-file buffers                                                             | One buffer per path, same cap. They outlive a runtime so the file stays complete.                                       | `test/host/idle.test.ts`                                                                                    |
| Effect devtools client (socket, fibers, queue)                                 | Skipped when no server answers. Closed with its runtime.                                                                | `test/host/devtools-server.test.ts` (connect and disconnect cycles, no server)                              |
| OTLP exporter buffers                                                          | Effect's exporter sends in batches. After a failure it pauses for 60 s and drops its buffer.                            | `test/host/leaks.test.ts` (collector up and down)                                                           |
| Metric registry (`host/metrics.ts`)                                            | Three metrics. The only attribute is the run outcome, so the series count is fixed.                                     | `test/host/leaks.test.ts`                                                                                   |
| Crash report directory (`host/crash.ts`)                                       | Newest 20 reports.                                                                                                      | `test/host/leaks.test.ts`                                                                                   |
| Devtools span book (`host/span-book.ts`)                                       | Caps on open spans, names, slowest spans, failures and metrics.                                                         | `test/host/span-book.test.ts`                                                                               |
| Devtools server sockets and per-connection state                               | The socket closes with its scope. State is dropped when a client disconnects.                                           | `test/host/devtools-server.test.ts`, `test/leaks/cli.test.ts`                                               |
| Signal listeners of `tiacore devtools`                                         | Both removed when the command ends.                                                                                     | `test/leaks/cli.test.ts`                                                                                    |
| CLI invocation (`execute`)                                                     | One scoped layer per call.                                                                                              | `test/leaks/cli.test.ts`                                                                                    |
| `doctor` checks and `doctor --perf` temp project                               | Checks write nothing. The temp directory is scoped and removed.                                                         | `test/leaks/cli.test.ts`, `test/cli/observability.test.ts`                                                  |
| Graph store files and commit lock                                              | Lock released in `finally`. Abandoned writes are cleaned.                                                               | `test/engine/leaks.test.ts`                                                                                 |
| In-memory graph store                                                          | Keeps the latest graph only.                                                                                            | `test/engine/leaks.test.ts`                                                                                 |
| Git baselines (child processes, repository-top cache)                          | Children are scoped. The cache lives as long as its layer and holds one entry per root.                                 | `test/engine/leaks.test.ts`, `test/leaks/core.test.ts`                                                      |
| `TiaCore` prepare and commit                                                   | No state outside the instance.                                                                                          | `test/leaks/core.test.ts`                                                                                   |
| Verification snapshot file handle                                              | Opened in `Effect.scoped`.                                                                                              | `test/leaks/core.test.ts` (snapshot written on every commit)                                                |
| Framework edge caches (`engine/edges`)                                         | One entry per project root.                                                                                             | `test/engine/edges/frameworks.test.ts`                                                                      |
| Coverage templates (`engine/coverage/templates.ts`)                            | Replaced at the start of each Vitest run, so a long-lived process keeps one run's templates.                            | `test/runners/vitest/leaks.test.ts`                                                                         |
| Coverage report writers                                                        | No state outside the call.                                                                                              | `test/leaks/coverage.test.ts`                                                                               |
| Artifact restore and the zip codec                                             | No state outside the call.                                                                                              | `test/artifacts/leaks.test.ts`                                                                              |
| Artifact HTTP requests (`artifacts/http.ts`)                                   | The body of a refused or oversized response is cancelled, so its connection is released.                                | `test/leaks/network.test.ts`                                                                                |
| Artifact publish                                                               | No state outside the call. The filesystem sink keeps every archive on purpose.                                          | `test/leaks/artifacts.test.ts`                                                                              |
| Child processes of runners (`runners/shared/process.ts`)                       | The process group is killed on timeout, interruption and scope close.                                                   | `test/runners/leaks.test.ts`, `test/leaks/processes.test.ts` (with a grandchild)                            |
| Child processes of verify, workspace, certify                                  | Same, plus a kill on output overflow.                                                                                   | `test/leaks/processes.test.ts`, `test/verification/verifier.test.ts`, `test/assurance/workspace.test.ts`    |
| External suites (`engine/scheduling.ts`)                                       | The child is killed when the run is interrupted. See the limits below.                                                  | `test/leaks/processes.test.ts`                                                                              |
| Vitest plugin registries (`runtimeStates`, `sharedStates`, `reporterRuntimes`) | One runtime per root and cache directory. The other two are weak.                                                       | `test/runners/vitest/leaks.test.ts` (watch starts, repeated runs)                                           |
| Vitest reporter maps                                                           | Keyed by test or file, per Vitest instance. The task metadata is deleted once read.                                     | `test/runners/vitest/leaks.test.ts` (whole runs from configuration to commit)                               |
| Worker coverage ledger (`probe/ledger.ts`)                                     | Drops files whose coverage object is gone. Windows close with each test.                                                | `test/probe/payload.test.ts`                                                                                |
| Playwright reporter observations                                               | One entry per test, cleared at the end of a run.                                                                        | `test/runners/playwright-reporter.test.ts`                                                                  |
| Playwright source-map memos                                                    | 256 entries each, least recently used first out.                                                                        | `test/runners/playwright-source-maps.test.ts`                                                               |
| Playwright source-map fetch                                                    | A refused or oversized body is cancelled.                                                                               | `test/leaks/network.test.ts`                                                                                |
| Node, adapter, Gradle, k6 and Maestro runs                                     | No state outside the call.                                                                                              | `test/runners/leaks.test.ts`, `*-behaviour.test.ts`                                                         |
| Evidence correlation (`AsyncLocalStorage`)                                     | Scoped to the callback.                                                                                                 | `test/evidence/evidence.test.ts`                                                                            |
| Verify and workspace runs                                                      | No state outside the call.                                                                                              | `test/verification/verifier.test.ts`, `test/assurance/workspace.test.ts`                                    |

## Leaks found and fixed

| Leak                                                                                                           | Fix                                                                         |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The Vitest plugin kept the coverage templates of every file version it ever transformed (also in 1.x).         | Replace the templates when a new Vitest run starts.                         |
| A response refused for size or status was not read or cancelled, so its connection stayed open (also in 1.x).  | Cancel the body in `artifacts/http.ts` and the Playwright source-map fetch. |
| Crash reports piled up without limit.                                                                          | Keep the newest 20.                                                         |
| A process with a devtools or OTLP exporter never ended, and Vitest waited ten seconds before it forced exit.   | The runtime closes itself when idle.                                        |
| Effect's devtools client keeps every span in memory while no server is listening.                              | tiacore does not start the client when nothing is listening.                |
| `tiacore devtools` left a `SIGTERM` listener behind each time it stopped (found by the sweep, before release). | Both listeners are removed when the wait ends.                              |

## Known limits

- If the devtools server disappears while a process runs, Effect's client
  buffers that process's spans until it exits. Spans are per stage, so the
  buffer stays small.
- When a run of external suites (k6, Gradle, Maestro) is interrupted, tiacore
  kills the suite's process but not its children. The suites share the
  terminal's process group so that Ctrl-C reaches them. Programmatic
  interruption therefore can leave grandchildren behind.
- Only the first Vitest instance in a process gets the tiacore reporter. This is
  the 1.x behaviour. A second instance in the same process runs without updating
  the graph.
- The Vitest runtime for a root keeps the last run's graph and plan until the
  next run or the end of the process.
- `windows` in the Vitest worker setup is a map that each test adds to and
  removes from. It has no direct test, because the setup file only runs inside a
  Vitest worker. The integration test `coverage-payload.test.ts` checks the
  metadata it carries.
- The filesystem artifact sink keeps every archive it wrote. The manifest's
  lineage names earlier archives. Prune the directory yourself.
- The Bun runner is not exercised here, because Bun is not part of the test
  environment.
