import { expect, test } from 'vitest'
import { value } from '../src/group-4'
import { measured } from './support'

test('parallel 04', () => measured('04', () => expect(value(1)).toBe(5)))
