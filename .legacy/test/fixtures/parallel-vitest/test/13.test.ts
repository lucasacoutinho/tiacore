import { expect, test } from 'vitest'
import { value } from '../src/group-1'
import { measured } from './support'

test('parallel 13', () => measured('13', () => expect(value(1)).toBe(2)))
