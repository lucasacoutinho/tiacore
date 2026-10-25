import picomatch from 'picomatch'

/** The one glob dialect of tiacore: picomatch with dotfiles matched. */
export function globMatcher(
  patterns: string | readonly string[],
): (path: string) => boolean {
  if (typeof patterns !== 'string' && patterns.length === 0) return () => false
  return picomatch(typeof patterns === 'string' ? patterns : [...patterns], {
    dot: true,
  })
}
