import { expect, test } from 'vitest'
import { value } from '../src/group-4'
import { measured } from './support'

test('parallel 16', () => measured('16', () => expect(value(1)).toBe(5)))
