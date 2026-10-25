import { expect, test } from 'vitest'
import { value } from '../src/group-2'
import { measured } from './support'

test('parallel 06', () => measured('06', () => expect(value(1)).toBe(3)))
