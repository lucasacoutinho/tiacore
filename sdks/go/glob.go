package tiacore

import (
	"regexp"
	"strings"
)

// The glob dialect shared by every tiacore runtime is a picomatch subset: `*` and
// `?` stay inside one path segment, a whole `**` segment spans zero or more
// segments, `[...]` is a class, `{a,b}` is an alternative and dotfiles match.

func expandBraces(pattern string) []string {
	start := strings.IndexByte(pattern, '{')
	if start == -1 {
		return []string{pattern}
	}
	depth, end := 0, -1
	for index := start; index < len(pattern) && end == -1; index++ {
		switch pattern[index] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				end = index
			}
		}
	}
	if end == -1 {
		return []string{pattern}
	}
	options := make([]string, 0, 2)
	depth = 0
	current := strings.Builder{}
	for _, char := range pattern[start+1 : end] {
		switch char {
		case '{':
			depth++
		case '}':
			depth--
		}
		if char == ',' && depth == 0 {
			options = append(options, current.String())
			current.Reset()
		} else {
			current.WriteRune(char)
		}
	}
	options = append(options, current.String())
	tails := expandBraces(pattern[end+1:])
	expanded := make([]string, 0, len(options)*len(tails))
	for _, option := range options {
		for _, tail := range tails {
			if len(options) == 1 {
				expanded = append(expanded, pattern[:start]+"{"+option+"}"+tail)
			} else {
				expanded = append(expanded, expandBraces(pattern[:start]+option+tail)...)
			}
		}
	}
	return expanded
}

func segmentRegexp(segment string) *regexp.Regexp {
	var out strings.Builder
	out.WriteString("^")
	runes := []rune(segment)
	for index := 0; index < len(runes); index++ {
		char := runes[index]
		switch {
		case char == '\\' && index+1 < len(runes):
			index++
			out.WriteString(regexp.QuoteMeta(string(runes[index])))
		case char == '*':
			for index+1 < len(runes) && runes[index+1] == '*' {
				index++
			}
			out.WriteString("[^/]*")
		case char == '?':
			out.WriteString("[^/]")
		case char == '[':
			closing := -1
			for probe := index + 2; probe < len(runes); probe++ {
				if runes[probe] == ']' {
					closing = probe
					break
				}
			}
			if closing == -1 {
				out.WriteString(regexp.QuoteMeta("["))
				continue
			}
			body := string(runes[index+1 : closing])
			negate := strings.HasPrefix(body, "!") || strings.HasPrefix(body, "^")
			if negate {
				body = body[1:]
			}
			out.WriteString("[")
			if negate {
				out.WriteString("^")
			}
			for _, member := range body {
				if member == '\\' || member == '[' || member == ']' || member == '^' {
					out.WriteString(`\`)
				}
				out.WriteRune(member)
			}
			out.WriteString("]")
			index = closing
		default:
			out.WriteString(regexp.QuoteMeta(string(char)))
		}
	}
	out.WriteString("$")
	return regexp.MustCompile("(?s)" + out.String())
}

type matchSegment struct {
	globstar bool
	pattern  *regexp.Regexp
}

type compiledGlob []matchSegment

func compileGlob(pattern string) compiledGlob {
	pattern = strings.TrimPrefix(pattern, "./")
	segments := strings.Split(pattern, "/")
	compiled := make(compiledGlob, len(segments))
	for index, segment := range segments {
		if segment == "**" {
			compiled[index] = matchSegment{globstar: true}
		} else {
			compiled[index] = matchSegment{pattern: segmentRegexp(segment)}
		}
	}
	return compiled
}

func (glob compiledGlob) matches(parts []string) bool {
	if len(glob) == 0 {
		return len(parts) == 0
	}
	head, rest := glob[0], glob[1:]
	if head.globstar {
		for skip := 0; skip <= len(parts); skip++ {
			if rest.matches(parts[skip:]) {
				return true
			}
		}
		return false
	}
	return len(parts) > 0 && head.pattern.MatchString(parts[0]) && rest.matches(parts[1:])
}

// globMatcher returns a predicate matching normalized paths against patterns.
func globMatcher(patterns ...string) func(string) bool {
	globs := make([]compiledGlob, 0, len(patterns))
	for _, pattern := range patterns {
		for _, expanded := range expandBraces(pattern) {
			globs = append(globs, compileGlob(expanded))
		}
	}
	return func(path string) bool {
		parts := strings.Split(path, "/")
		for _, glob := range globs {
			if glob.matches(parts) {
				return true
			}
		}
		return false
	}
}
