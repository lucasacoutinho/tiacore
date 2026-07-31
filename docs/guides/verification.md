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
  --cwd apps/platform \
  --output ../../.tia/platform-verification.json \
  -- npm test
```

Programmatic callers use the same `tia()` factory:

```ts
import { tia } from '@usescherie/tiacore/verification'

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
- identical test outcomes, excluding timing;
- identical test-to-file dependency evidence;
- identical reconstructed coverage topology when coverage is complete.

Coverage hit counts are reduced to covered or uncovered before comparison.
Exact counters can vary with retries, polling, and worker scheduling while
producing the same report and threshold result. Per-test shards may also vary
without changing their merged report, so the gate compares the complete
per-file reconstruction used by native coverage output.

The receipt distinguishes verification from command health. `verified` means
both phases agreed; `success` additionally requires both commands to exit with
status zero. Matching failures therefore prove equivalent selection without
turning a failing suite green.

The same receipt is the performance record. It includes wall time for each
phase, executed and replayed test counts per runner, execution reduction,
duration saved, measured speedup, and every selective runner that fell back to
record mode with its reason. Treat speedup as a measured value for that
repository state, not a universal package claim.

## Use it during adapter development

Keep normal local and CI commands selective. Run differential verification for
a new runner, a new framework edge, or a representative changed-file matrix.
For a large repository, verify bounded lanes independently before scheduling a
periodic workspace-wide gate. The full phase sets `TIA_FRESH=1`; adapters built
on `TiaCore` inherit that behavior automatically.

Snapshots use temporary storage by default and are removed after the receipt is
created. Pass `artifactsDirectory` through the API when debugging a mismatch and
retain that directory as a CI diagnostic artifact.
