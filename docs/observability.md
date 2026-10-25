# Observability

tiacore can tell you what it is doing and where the time goes. You can watch
spans live, save them to a file, send them to a collector, and read a report
when tiacore crashes.

All of it is off until you set an environment variable. With nothing set,
tiacore loads no exporter code and pays no cost.

## Environment variables

| Variable               | Value                              | What it does                                                                                              |
| ---------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `TIACORE_DEVTOOLS`     | `1`, `true`, `yes`, `on`, or a URL | Sends spans and metrics to a devtools server. A truthy word means `ws://localhost:34437`.                 |
| `TIACORE_OTLP_URL`     | Base URL of an OTLP/HTTP collector | Sends traces, metrics and logs to `<url>/v1/traces`, `<url>/v1/metrics` and `<url>/v1/logs`.              |
| `TIACORE_TRACE_FILE`   | A file path                        | Writes every finished span as JSON. Keeps the newest 10,000 spans.                                        |
| `TIACORE_METRICS_FILE` | A file path                        | Writes all metrics in Prometheus text format.                                                             |
| `TIACORE_CRASH_DIR`    | A directory                        | Where crash reports go. The default is `.tia/crashes`. Crash reports are always on; this only moves them. |

A blank value counts as unset. You can combine the first four.

Example:

```sh
TIACORE_TRACE_FILE=trace.json TIACORE_METRICS_FILE=metrics.prom npx vitest run
```

### When the files and exporters are flushed

- The `tiacore` command writes the files and flushes the exporters when it ends.
- A library call, such as the Vitest plugin or a runner's `run()`, flushes half
  a second after its last run. If the process ends first, it still writes the
  trace and metrics files on exit.
- Each flush rewrites the trace file with every span the process has recorded so
  far.
- OTLP export waits at most three seconds at exit. If the collector fails,
  tiacore stops sending for 60 seconds and drops what it held.
- The devtools client needs a server that is already listening. If none answers,
  tiacore prints one line to stderr and sends nothing. Start `tiacore devtools`
  first.

## What tiacore reports

Spans mark stages, never single tests. The main ones:

| Span                                                                    | Stage                                         |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| `tia.prepare`                                                           | Read the stored graph and plan the run        |
| `tia.commit`, `tia.vitest.commit`                                       | Record what the run observed                  |
| `tia.baseline.fingerprint`, `tia.baseline.snapshot`                     | Hash the project and capture the git baseline |
| `tia.store.read`, `tia.store.commit`                                    | Read and write the graph store                |
| `tia.artifacts.restore`, `tia.artifacts.publish`                        | Fetch or publish a graph                      |
| `tia.coverage.report`                                                   | Rebuild coverage and write reports            |
| `tia.playwright.run`, `tia.k6.run`, `tia.gradle.run`, `tia.maestro.run` | One runner run                                |
| `tia.verify.run`, `tia.cli.<command>`                                   | A verification, or a CLI command              |

Three metrics describe each host run (one prepare, one commit, one
verification):

| Metric                | Type      | Meaning                                                                    |
| --------------------- | --------- | -------------------------------------------------------------------------- |
| `tia_runs_total`      | counter   | Runs, with an `outcome` of `success`, `failure`, `defect` or `interrupted` |
| `tia_run_duration_ms` | histogram | Wall time of a run                                                         |
| `tia_heap_used_bytes` | gauge     | V8 heap in use when the last run ended                                     |

A trace file looks like this:

```json
{
  "spans": [
    {
      "name": "tia.prepare",
      "durationMs": 5.6,
      "status": "success",
      "attributes": {},
      "traceId": "...",
      "spanId": "...",
      "parentSpanId": null,
      "startUnixNanos": "1790000000000000000"
    }
  ],
  "tiacore": "2.0.0"
}
```

`status` is `success`, `failure` or `interrupted`.

## `tiacore devtools`

Starts a server that receives spans and metrics from other tiacore processes and
prints a live summary.

```sh
# terminal 1
npx tiacore devtools

# terminal 2
TIACORE_DEVTOOLS=1 npx vitest run
```

The server speaks Effect's devtools protocol, so Effect editor extensions can
connect to it too.

| Flag         | Default     | Meaning                                            |
| ------------ | ----------- | -------------------------------------------------- |
| `--port`     | `34437`     | Port to listen on. `0` picks a free port.          |
| `--host`     | `localhost` | Interface to listen on.                            |
| `--interval` | `1000`      | Milliseconds between summaries. The minimum is 50. |

The summary has four parts:

- **Slowest spans.** The 10 longest spans, with the process that sent them
  (`#1`, `#2`, ...). The server keeps the 20 longest.
- **Time by span name.** Count, total time, longest time and error count for
  each name.
- **Failed spans.** The newest failures, with the first line of the error.
- **Metrics.** The latest value of each metric.

In a terminal the summary redraws in place. When output is piped, each change
prints a new block.

The server keeps a fixed amount of memory. It holds the 20 longest spans, up to
500 span names, the newest 20 failures and up to 1,000 metrics. Spans that never
end are dropped when their process disconnects.

Press Ctrl-C to stop. The server prints a final summary and exits with code 0.
If the port is taken, it exits with code 1 and says so.

One server can serve many processes. Each connection gets a number in the
summary. A `tiacore` command makes two connections: one for the command itself
(`tia.cli.*` spans) and one for the engine runs it starts. A runtime that sits
idle for half a second closes, so a long-lived process can appear under a new
number after a pause. Metrics reach the server when it asks for them, which it
does every two seconds and after spans end. A very short run can end before it
answers.

## `tiacore doctor`

Checks that the install can work.

```sh
npx tiacore doctor
npx tiacore doctor --perf
npx tiacore doctor --json
```

The checks:

- **Node.js.** The version must satisfy `^22.12.0 || >=24.0.0`.
- **git.** Reports the version. Without git, tiacore falls back to file
  snapshots, which are slower.
- **Peers.** Looks for `vitest`, `vite` and `@playwright/test` from the current
  directory upward. A version outside the supported range fails. A missing peer
  is only a note. `typescript` is listed when found.
- **Cache directory.** Is `.tia` writable? Change it with `--cache-dir`.
- **Crash directory.** Is the crash report directory writable?
- **Observability.** Lists the `TIACORE_*` variables that are set.

The checks never write to your project. They look at the directory, or at its
nearest existing parent, and do not create anything.

The exit code is 1 if a check fails, and 0 otherwise.

### `--perf`

Adds a timing run. tiacore makes a throwaway git project in the temp directory,
with 40 test files, and times:

1. a cold `prepare`, with no stored graph;
2. a `commit` of 40 test results;
3. a warm `prepare` after one source file changes.

It prints the phases from slowest to fastest, then the engine spans from largest
total time to smallest. Your project is not read or written. The temp project is
removed when the command ends.

If git is missing, the timing run is skipped and the report says why.

### `--json`

Prints one JSON object instead of text.

```json
{
  "tiacore": "2.0.0",
  "ok": true,
  "checks": [
    {
      "id": "node",
      "title": "Node.js",
      "status": "ok",
      "detail": "v22.12.0 satisfies ^22.12.0 || >=24.0.0"
    }
  ],
  "perf": {
    "project": { "testFiles": 40 },
    "phases": [{ "name": "commit (40 tests)", "milliseconds": 86.2 }],
    "spans": [
      {
        "name": "tia.baseline.snapshot",
        "count": 3,
        "totalMilliseconds": 91,
        "maxMilliseconds": 33
      }
    ]
  }
}
```

`status` is `ok`, `info`, `warn` or `fail`. `perf` appears only with `--perf`.
`--output <path>` writes the JSON to a file.

### `--graph`

`tiacore doctor --graph <file>` still validates a runner-neutral graph, as in
1.x. It prints `{ "ok": true, "protocolVersion": 1, "suites": <count> }` and
fails on an invalid graph.

## Crash reports

A crash is a defect: a bug in tiacore, not an input error or a failed test. When
one happens, tiacore writes a report and prints its path:

```text
TIA crash report written to .tia/crashes/crash-2026-10-25T11-37-30.750Z-519573.json
```

This happens for library calls and for CLI commands. Expected failures, such as
a missing file, write no report.

A report holds the error and its causes, the command line arguments, the Node.js
version, the platform and the tiacore version. The value of any flag whose name
contains `token`, `secret`, `password`, `passwd`, `credential`, `auth` or `key`
is replaced with `<redacted>`.

tiacore keeps the 20 newest reports in the directory and removes older ones.

## Memory

Every long-lived resource in tiacore has a test that runs it many times and
checks that heap, open handles and file descriptors stop growing. The list is in
[the leak sweep](architecture/leak-sweep.md).
