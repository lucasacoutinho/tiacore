import * as Effect from 'effect/Effect'

import { resolve } from 'node:path'

import type {
  TiaArtifactPublisherOptions,
  TiaArtifactPublishReceipt,
  TiaArtifactSink,
  TiaFilesystemArtifactSinkOptions,
} from '../../core/artifacts.ts'
import { runPromise } from '../../host/runtime.ts'
import { GraphStoreLive } from '../state/graph-store.ts'
import {
  configure,
  optionsProblem,
  publishConfigured,
  type PublisherConfig,
} from './publish.ts'
import { FILESYSTEM_SINK_NAME, putToDirectory } from './sink.ts'

// The public Promise surface of the publisher. Effect stays in publish.ts, so
// no public declaration file reaches it.

export class TiaArtifactPublisher {
  private readonly config: PublisherConfig

  constructor(options: TiaArtifactPublisherOptions) {
    const problem = optionsProblem(options)
    if (problem !== null) throw new Error(problem)
    this.config = configure(options)
  }

  publish(): Promise<TiaArtifactPublishReceipt> {
    return this.write(false)
  }

  promote(): Promise<TiaArtifactPublishReceipt> {
    return this.write(true)
  }

  private write(promoted: boolean): Promise<TiaArtifactPublishReceipt> {
    return runPromise(
      publishConfigured(this.config, promoted).pipe(
        Effect.provide(GraphStoreLive),
      ),
    )
  }
}

export function tia(
  options: TiaArtifactPublisherOptions,
): TiaArtifactPublisher {
  return new TiaArtifactPublisher(options)
}

export function createFilesystemArtifactSink(
  options: TiaFilesystemArtifactSinkOptions = {},
  root = process.cwd(),
): TiaArtifactSink {
  const directory = resolve(root, options.directory ?? '.tia-artifacts')
  return {
    name: FILESYSTEM_SINK_NAME,
    put: (input) =>
      runPromise(putToDirectory(directory, options.baseUrl, input)),
  }
}
