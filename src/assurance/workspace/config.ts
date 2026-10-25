import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'

import { errorMessage, TiaInvalid } from '../../wire/errors.ts'
import { decodeWorkspaceOptions } from './options.ts'
import { TiaWorkspaceRunner } from './runner.ts'

/** What a workspace config module hands back: something with run(). */
export interface LoadedWorkspace {
  run(): Promise<unknown>
}

/**
 * Imports the config module (default export, else `workspace`) and returns a
 * runner. An export with a run() method is used as is, whatever copy of
 * tiacore built it; anything else must be workspace options.
 */
export const loadWorkspace = Effect.fnUntraced(function* (config: string) {
  const location = pathToFileURL(resolve(config)).href
  const loaded = yield* Effect.tryPromise({
    catch: (error) => new TiaInvalid({ message: errorMessage(error) }),
    try: (): Promise<unknown> => import(location),
  })
  const configured = Predicate.isObject(loaded)
    ? (Reflect.get(loaded, 'default') ?? Reflect.get(loaded, 'workspace'))
    : undefined
  if (configured === undefined) {
    return yield* new TiaInvalid({
      message: `TIA workspace config ${config} must export default or workspace`,
    })
  }
  if (
    Predicate.hasProperty(configured, 'run') &&
    Predicate.isFunction(configured.run) &&
    !Predicate.hasProperty(configured, 'lanes')
  ) {
    const run = configured.run
    const runnable: LoadedWorkspace = {
      run: async () => await Reflect.apply(run, configured, []),
    }
    return runnable
  }
  return yield* Effect.try({
    catch: (error) => new TiaInvalid({ message: errorMessage(error) }),
    try: () => new TiaWorkspaceRunner(decodeWorkspaceOptions(configured)),
  })
})
