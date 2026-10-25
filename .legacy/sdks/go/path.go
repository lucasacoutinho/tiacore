package tiacore

import (
	"fmt"
	"path"
	"path/filepath"
	"strings"
)

func normalizePath(value string) (string, error) {
	value = strings.ReplaceAll(value, `\`, "/")
	if strings.Contains(value, "://") {
		return "", fmt.Errorf("unsafe tiacore path: %q", value)
	}
	value = strings.TrimPrefix(value, "./")
	value = path.Clean(value)
	if value == "" || value == "." || strings.ContainsRune(value, 0) || strings.HasPrefix(value, "/") {
		return "", fmt.Errorf("unsafe tiacore path: %q", value)
	}
	if len(value) >= 2 && value[1] == ':' {
		return "", fmt.Errorf("unsafe tiacore path: %q", value)
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("unsafe tiacore path: %q", value)
		}
	}
	return value, nil
}

func relativePath(root, value string) (string, error) {
	relative, err := filepath.Rel(root, value)
	if err != nil {
		return "", err
	}
	return normalizePath(filepath.ToSlash(relative))
}

func matchesInvalidator(pattern, changed string) bool {
	if strings.HasSuffix(pattern, "/**") {
		prefix := strings.TrimSuffix(pattern, "**")
		return strings.HasPrefix(changed, prefix)
	}
	matched, err := path.Match(pattern, changed)
	return err == nil && matched
}
