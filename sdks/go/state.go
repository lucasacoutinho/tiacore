package tiacore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type state struct {
	StateVersion int               `json:"stateVersion"`
	Graph        Graph             `json:"graph"`
	Snapshot     map[string]string `json:"snapshot"`
}

func readState(path string) (*state, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 256<<20))
	decoder.DisallowUnknownFields()
	var value state
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if value.StateVersion != stateVersion || value.Graph.ProtocolVersion != ProtocolVersion || !value.Graph.Complete || value.Snapshot == nil {
		return nil, errors.New("incompatible tiacore Go state")
	}
	return &value, nil
}

func writeState(path string, value state) error {
	return writeAtomically(path, func(file io.Writer) error {
		encoder := json.NewEncoder(file)
		encoder.SetIndent("", "  ")
		return encoder.Encode(value)
	})
}

// writeAtomically writes path through a sibling temporary file renamed into place,
// so a reader never sees a partial file and a failed write leaves no temporary behind.
func writeAtomically(path string, encode func(io.Writer) error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := encode(temporary); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func captureSnapshot(root string) (map[string]string, error) {
	paths, err := gitFiles(root)
	if err != nil {
		paths, err = walkedFiles(root)
		if err != nil {
			return nil, err
		}
	}
	snapshot := make(map[string]string, len(paths))
	for _, relative := range paths {
		normalized, err := normalizePath(relative)
		if err != nil || excludedPath(normalized) {
			continue
		}
		absolute := filepath.Join(root, filepath.FromSlash(normalized))
		info, err := os.Lstat(absolute)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		var digest string
		if info.Mode()&os.ModeSymlink != 0 {
			target, readErr := os.Readlink(absolute)
			if readErr != nil {
				return nil, readErr
			}
			hash := sha256.Sum256([]byte("symlink:" + target))
			digest = hex.EncodeToString(hash[:])
		} else if info.Mode().IsRegular() {
			file, openErr := os.Open(absolute)
			if openErr != nil {
				return nil, openErr
			}
			hash := sha256.New()
			_, copyErr := io.Copy(hash, file)
			closeErr := file.Close()
			if copyErr != nil {
				return nil, copyErr
			}
			if closeErr != nil {
				return nil, closeErr
			}
			digest = hex.EncodeToString(hash.Sum(nil))
		} else {
			continue
		}
		snapshot[normalized] = digest
	}
	return snapshot, nil
}

func gitFiles(root string) ([]string, error) {
	command := exec.Command("git", "ls-files", "-co", "--exclude-standard", "-z")
	command.Dir = root
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	values := strings.Split(string(output), "\x00")
	result := values[:0]
	for _, value := range values {
		if value != "" {
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result, nil
}

func walkedFiles(root string) ([]string, error) {
	result := make([]string, 0)
	err := filepath.WalkDir(root, func(value string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := relativePath(root, value)
		if err != nil {
			if value == root {
				return nil
			}
			return err
		}
		if entry.IsDir() {
			if value != root && excludedPath(relative) {
				return filepath.SkipDir
			}
			return nil
		}
		if !excludedPath(relative) {
			result = append(result, relative)
		}
		return nil
	})
	return result, err
}

func excludedPath(value string) bool {
	for _, directory := range []string{".git", ".tia", ".worktrees", "node_modules", "dist", "build", "coverage"} {
		if value == directory || strings.HasPrefix(value, directory+"/") {
			return true
		}
	}
	return false
}

func changedFiles(previous, current map[string]string) []string {
	changed := make([]string, 0)
	for file, digest := range previous {
		if current[file] != digest {
			changed = append(changed, file)
		}
	}
	for file := range current {
		if _, exists := previous[file]; !exists {
			changed = append(changed, file)
		}
	}
	return sortedUnique(changed)
}

func statePath(root, cacheDirectory string) (string, error) {
	if cacheDirectory == "" {
		cacheDirectory = ".tia/go"
	}
	if filepath.IsAbs(cacheDirectory) {
		return filepath.Join(cacheDirectory, "state.json"), nil
	}
	path := filepath.Clean(filepath.Join(root, cacheDirectory, "state.json"))
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("cache directory escapes project: %s", cacheDirectory)
	}
	return path, nil
}
