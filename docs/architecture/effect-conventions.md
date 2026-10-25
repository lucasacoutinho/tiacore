# Effect conventions

These rules apply to every module under `src/`. The
[architecture overview](overview.md) describes what the layers do. A change to
public behavior needs a CHANGELOG entry, and a breaking one also needs the
migration guide.

## Layout and layering

| Directory       | Holds                                                         | May import                                  |
| --------------- | ------------------------------------------------------------- | ------------------------------------------- |
| `src/core`      | Pure decisions and plain public types. No Effect, no `node:`. | nothing in `src/`                           |
| `src/probe`     | Worker-side coverage ledger. No Effect, no `node:`.           | `core`                                      |
| `src/evidence`  | The evidence SDK leaf. No Effect.                             | nothing in `src/`                           |
| `src/wire`      | Effect Schemas, tagged errors, decoders.                      | `core`                                      |
| `src/host`      | The Promise bridge, observability layers.                     | `core`, `wire`                              |
| `src/engine`    | The Effect shell: store, baseline, planning, artifacts, ...   | `core`, `wire`, `host`, `probe`             |
| `src/runners`   | One directory per runner.                                     | the layers above                            |
| `src/assurance` | verify, certify, workspace.                                   | `core`, `wire`, `host`, `engine`, `runners` |
| `src/cli`       | The CLI.                                                      | everything except `entries`                 |
| `src/entries`   | One thin file per `package.json` export. Re-exports only.     | everything                                  |

`archer.config.ts` enforces the table, and `test/package/purity.test.ts` keeps
Effect and `node:` out of `core` and `probe`. Keep files under 800 lines.

## Public seams

- Public functions take and return plain values, Promises and plain interfaces.
  Effect never appears in a public signature or a public declaration file
  (`test/package/bundle.test.ts` follows every entry's declarations).
- Public types are hand-written interfaces in `src/core`. A Schema that decodes
  into one must be typed so the compiler checks the result against the interface
  (see `src/wire/decode.ts`). Never cast a decoded value.
- A public effectful function calls `runPromise` from `src/host/runtime.ts`.
  Tagged failures become an `Error` with the 1.x message.
- Files whose declarations would export a Schema value are internal. Put the
  public decode function in a separate module (`wire/decode.ts`).

## Effect style

- `Effect.fn('tia.<area>.<operation>')` only at stage granularity (plan, record,
  commit, restore, publish, verify). Use `Effect.fnUntraced` for other reusable
  effects. Never put Effect, spans or metrics on a per-test, per-counter or
  per-file hot loop; those stay plain TypeScript.
- Services are `Context.Service` classes. The engine's seams are declared in
  `src/engine/ports.ts`; add a seam only when it has two real adapters (a live
  one and an in-memory one counts). Use Effect's built-in `FileSystem`, `Path`
  and `ChildProcessSpawner` instead of wrapping them.
- Errors are the four tagged classes in `src/wire/errors.ts`. Their messages are
  part of the CLI contract; tests pin them.
- Resources (locks, sockets, child processes, watchers) are acquired with
  `Effect.acquireRelease` inside a Scope that the caller's program owns. The
  process-wide runtime holds only stateless services.
- Use `Match` for classification over tagged unions at file, edge or error
  granularity; plain `switch` inside hot loops.

## Data rules

- Validate with Schema built-ins first (`NonEmptyString`, `Int`, `Finite`,
  `isMaxLength`, `Literals`, `isBetween`, ...). Use `makeFilter` for rules no
  built-in expresses. A regex is the last resort, always with the `u` flag
  (without it `isPattern` drops the constraint from JSON Schema).
- Decode with Schema only where data crosses a trust boundary: user input,
  artifacts, interchange files, configuration. tiacore's own cache uses
  `parseRuntimeGraph` (a type guard, no copy) after reading.
- Order every collection with `byCodeUnit` / `sortByKey` from
  `src/core/canonical.ts`. Never use `localeCompare`.
- Normalize paths with `normalizePath` (`src/core/path.ts`). Match changed
  paths, invalidators and ignore lists with `globMatcher`
  (`src/engine/glob.ts`). Three 1.x dialects stay as they were, each pinned by a
  test: coverage threshold globs and subprocess edge `tests` use picomatch
  defaults (no dot files), and coverage include/exclude uses
  `{ contains: true, dot: true }`.

## Tests

- Test behavior through the public seams. Use `@effect/vitest` (`it.effect`,
  `it.prop`) for Effect code and properties.
- Where 2.0 must behave like 1.x, compare with the published 1.2.1 through
  `test/support/legacy.ts` (the `tiacore-v1` development dependency).
- Every long-lived resource and every past leak gets a test with `assertNoLeak`
  from `test/support/leak.ts`.
- Pure decisions in `src/core` get a Lean model in `proofs/` and vectors in
  `conformance/`; `npm run check:proofs` audits the axioms.

## Before every commit

Run `npm run gate` and read its exit code; do not pipe it. Commit subjects
follow Conventional Commits and end with the co-author line.
