// Usage: node config/selection-vectors.ts write | check | fuzz [count]
//   write  regenerate conformance/selection/v1/vectors.json from the Lean model
//   check  fail if the committed vectors differ from the Lean model's answers
//   fuzz   compare the TypeScript kernel with the Lean model on fresh random problems
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

import { select } from '../src/core/select.ts'
import {
  canonicalModelSelection,
  fromModel,
  generateProblems,
  type ModelProblem,
  type ModelSelection,
} from '../test/support/selection-problems.ts'

const VECTORS = 'conformance/selection/v1/vectors.json'
const VECTOR_SEED = 20_261_025
const VECTOR_COUNT = 500

function model(problems: readonly ModelProblem[]): ModelSelection[] {
  const result = spawnSync('lake', ['exe', 'tia-ref'], {
    cwd: 'proofs',
    encoding: 'utf8',
    input: JSON.stringify(problems),
    maxBuffer: 1 << 30,
  })
  if (result.status !== 0) {
    throw new Error(`tia-ref failed: ${result.stderr}`)
  }
  return (JSON.parse(result.stdout) as ModelSelection[]).map(
    canonicalModelSelection,
  )
}

function vectors(): string {
  const problems = generateProblems(VECTOR_SEED, VECTOR_COUNT)
  const expected = model(problems)
  const cases = problems.map((problem, index) => ({
    expected: expected[index],
    problem,
  }))
  return `${JSON.stringify({ cases, seed: VECTOR_SEED, version: 1 }, null, 1)}\n`
}

const [mode = 'check', countArgument] = process.argv.slice(2)
if (mode === 'write') {
  writeFileSync(VECTORS, vectors())
} else if (mode === 'check') {
  if (readFileSync(VECTORS, 'utf8') !== vectors()) {
    console.error(`${VECTORS} differs from the Lean model; run with write`)
    process.exitCode = 1
  }
} else if (mode === 'fuzz') {
  const count = Number(countArgument ?? 20_000)
  const seed = Date.now()
  const problems = generateProblems(seed, count)
  const expected = model(problems)
  const failures = problems.flatMap((problem, index) => {
    const actual = canonicalModelSelection(
      ((selection) =>
        selection._tag === 'Full'
          ? { full: { because: selection.cause.path } }
          : {
              only: {
                groups: [...selection.groups],
                items: [...selection.items],
              },
            })(select(fromModel(problem))),
    )
    return isDeepStrictEqual(actual, expected[index])
      ? []
      : [{ actual, expected: expected[index], problem }]
  })
  console.log(
    `seed ${seed}: ${count} problems, ${failures.length} disagreements`,
  )
  if (failures.length > 0) {
    console.error(JSON.stringify(failures[0], null, 1))
    process.exitCode = 1
  }
} else {
  console.error(`unknown mode ${mode}`)
  process.exitCode = 2
}
