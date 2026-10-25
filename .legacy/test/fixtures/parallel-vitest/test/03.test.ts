import { expect, test } from 'vitest'
import { value } from '../src/group-3'
import { measured } from './support'

test('parallel 03', () => measured('03', () => expect(value(1)).toBe(4)))
