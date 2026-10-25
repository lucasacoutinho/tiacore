import { expect, test } from 'vitest'
import { value } from '../src/group-1'
import { measured } from './support'

test('parallel 01', () => measured('01', () => expect(value(1)).toBe(2)))
