package tiacore

import (
	"fmt"
	"path/filepath"
	"strings"
)

const maxPathLength = 4096

func isSchemeStart(char byte) bool {
	return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
}

func hasScheme(segment string) bool {
	colon := strings.IndexByte(segment, ':')
	if colon < 1 || !isSchemeStart(segment[0]) {
		return false
	}
	for index := 1; index < colon; index++ {
		char := segment[index]
		if !isSchemeStart(char) && (char < '0' || char > '9') && char != '+' && char != '-' && char != '.' {
			return false
		}
	}
	return true
}

// normalizePath returns the canonical project-relative form of value: `\` becomes
// `/`, empty and `.` segments disappear (so trailing slashes are dropped), `..`
// pops a segment, and a path that climbs out of the project, is absolute, empty,
// longer than 4096 UTF-16 units or starts with a URI scheme is rejected.
func normalizePath(value string) (string, error) {
	unsafe := fmt.Errorf("unsafe tiacore path: %q", value)
	if strings.ContainsRune(value, 0) || utf16Length(value) > maxPathLength {
		return "", unsafe
	}
	slashed := strings.ReplaceAll(value, `\`, "/")
	if strings.HasPrefix(slashed, "/") {
		return "", unsafe
	}
	kept := make([]string, 0, 8)
	for _, segment := range strings.Split(slashed, "/") {
		switch segment {
		case "", ".":
		case "..":
			if len(kept) == 0 {
				return "", unsafe
			}
			kept = kept[:len(kept)-1]
		default:
			kept = append(kept, segment)
		}
	}
	if len(kept) == 0 || hasScheme(kept[0]) {
		return "", unsafe
	}
	return strings.Join(kept, "/"), nil
}

// withinRoot reports whether value is root itself or a path below it.
func withinRoot(root, value string) bool {
	relative, err := filepath.Rel(root, value)
	if err != nil {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func relativePath(root, value string) (string, error) {
	relative, err := filepath.Rel(root, value)
	if err != nil {
		return "", err
	}
	return normalizePath(filepath.ToSlash(relative))
}
