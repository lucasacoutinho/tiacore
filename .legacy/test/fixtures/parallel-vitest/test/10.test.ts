import { expect, test } from 'vitest'
import { value } from '../src/group-2'
import { measured } from './support'

test('parallel 10', () => measured('10', () => expect(value(1)).toBe(3)))
