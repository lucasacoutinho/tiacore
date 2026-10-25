import { expect, test } from 'vitest'
import { value } from '../src/group-4'
import { measured } from './support'

test('parallel 08', () => measured('08', () => expect(value(1)).toBe(5)))
