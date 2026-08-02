package tiacore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type goPackage struct {
	Dir             string
	ImportPath      string
	Name            string
	GoFiles         []string
	CgoFiles        []string
	CFiles          []string
	CXXFiles        []string
	MFiles          []string
	HFiles          []string
	FFiles          []string
	SFiles          []string
	SwigFiles       []string
	SwigCXXFiles    []string
	SysoFiles       []string
	EmbedFiles      []string
	TestGoFiles     []string
	XTestGoFiles    []string
	TestEmbedFiles  []string
	XTestEmbedFiles []string
	Imports         []string
	TestImports     []string
	XTestImports    []string
	Module          *struct {
		Path string
		Main bool
	}
}

type catalog struct {
	Graph         Graph
	SuitePackages map[string]string
}

func discover(ctx context.Context, options Options, root, environmentFingerprint string) (catalog, error) {
	patterns := options.PackagePatterns
	if len(patterns) == 0 {
		patterns = []string{"./..."}
	}
	arguments := append([]string{"list", "-json"}, patterns...)
	command := exec.CommandContext(ctx, options.GoBinary, arguments...)
	command.Dir = root
	command.Env = commandEnvironment(options.Environment)
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = options.Stderr
	if err := command.Run(); err != nil {
		return catalog{}, fmt.Errorf("discover Go packages: %w", err)
	}

	decoder := json.NewDecoder(&output)
	packages := make(map[string]goPackage)
	for {
		var item goPackage
		if err := decoder.Decode(&item); err == io.EOF {
			break
		} else if err != nil {
			return catalog{}, fmt.Errorf("decode go list output: %w", err)
		}
		if item.ImportPath == "" || item.Dir == "" {
			continue
		}
		if _, err := relativePath(root, item.Dir); err != nil {
			continue
		}
		packages[item.ImportPath] = item
	}
	if len(packages) == 0 {
		return catalog{}, fmt.Errorf("go list discovered no project packages")
	}

	allPackages := make([]string, 0, len(packages))
	for importPath := range packages {
		allPackages = append(allPackages, importPath)
	}
	sort.Strings(allPackages)

	project := options.Project
	if project == "" {
		for _, item := range packages {
			if item.Module != nil && item.Module.Main {
				project = item.Module.Path
				break
			}
		}
	}
	if project == "" {
		project = "go"
	}

	suites := make([]Suite, 0)
	suitePackages := make(map[string]string)
	for _, importPath := range allPackages {
		item := packages[importPath]
		testFiles := append([]string{}, item.TestGoFiles...)
		testFiles = append(testFiles, item.XTestGoFiles...)
		sort.Strings(testFiles)
		representative := testFiles
		tags := []string{"go-package:" + importPath, "go-tests"}
		if len(representative) == 0 {
			representative = packageFiles(item)
			tags[1] = "go-compile"
		}
		if len(representative) == 0 {
			continue
		}
		file, err := relativePath(root, filepath.Join(item.Dir, representative[0]))
		if err != nil {
			return catalog{}, err
		}
		id := "go-package:" + importPath
		suites = append(suites, Suite{Adapter: "go-test", File: file, ID: id, Project: project, Tags: tags})
		suitePackages[id] = importPath
	}
	sort.Slice(suites, func(left, right int) bool { return suites[left].ID < suites[right].ID })

	observations := make([]Observation, 0)
	for _, suite := range suites {
		importPath := suitePackages[suite.ID]
		dependencies := transitivePackageFiles(root, importPath, packages)
		for _, source := range dependencies {
			kind := "import"
			if source == suite.File {
				kind = "configuration"
			}
			observations = append(observations, Observation{Confidence: "inferred", Kind: kind, Source: source, SuiteID: suite.ID})
		}
	}
	sort.Slice(observations, func(left, right int) bool {
		if observations[left].SuiteID != observations[right].SuiteID {
			return observations[left].SuiteID < observations[right].SuiteID
		}
		if observations[left].Source != observations[right].Source {
			return observations[left].Source < observations[right].Source
		}
		return observations[left].Kind < observations[right].Kind
	})
	fingerprint, err := catalogFingerprint(root, suites, patterns)
	if err != nil {
		return catalog{}, err
	}
	return catalog{
		Graph: Graph{
			ProtocolVersion:        ProtocolVersion,
			Complete:               true,
			Fingerprint:            fingerprint,
			EnvironmentFingerprint: environmentFingerprint,
			Invalidators: []Invalidator{
				{Pattern: "go.mod", Reason: "Go module structure changed"},
				{Pattern: "go.sum", Reason: "Go dependency resolution changed"},
				{Pattern: "go.work", Reason: "Go workspace structure changed"},
				{Pattern: "go.work.sum", Reason: "Go workspace dependency resolution changed"},
				{Pattern: "vendor/**", Reason: "vendored Go dependencies changed"},
			},
			Suites:       suites,
			Observations: observations,
		},
		SuitePackages: suitePackages,
	}, nil
}

func packageFiles(item goPackage) []string {
	files := make([]string, 0)
	for _, group := range [][]string{
		item.GoFiles, item.CgoFiles, item.CFiles, item.CXXFiles, item.MFiles,
		item.HFiles, item.FFiles, item.SFiles, item.SwigFiles, item.SwigCXXFiles,
		item.SysoFiles, item.EmbedFiles, item.TestGoFiles, item.XTestGoFiles,
		item.TestEmbedFiles, item.XTestEmbedFiles,
	} {
		files = append(files, group...)
	}
	sort.Strings(files)
	return uniqueStrings(files)
}

func transitivePackageFiles(root, start string, packages map[string]goPackage) []string {
	visited := make(map[string]struct{})
	pending := []string{start}
	files := make(map[string]struct{})
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if _, exists := visited[current]; exists {
			continue
		}
		visited[current] = struct{}{}
		item, exists := packages[current]
		if !exists {
			continue
		}
		for _, file := range packageFiles(item) {
			if relative, err := relativePath(root, filepath.Join(item.Dir, file)); err == nil {
				files[relative] = struct{}{}
			}
		}
		imports := append([]string{}, item.Imports...)
		if current == start {
			imports = append(imports, item.TestImports...)
			imports = append(imports, item.XTestImports...)
		}
		for _, imported := range imports {
			if _, local := packages[imported]; local {
				pending = append(pending, imported)
			}
		}
	}
	result := make([]string, 0, len(files))
	for file := range files {
		result = append(result, file)
	}
	sort.Strings(result)
	return result
}

func catalogFingerprint(root string, suites []Suite, patterns []string) (string, error) {
	hash := sha256.New()
	encoded, err := json.Marshal(struct {
		Patterns []string `json:"patterns"`
		Suites   []Suite  `json:"suites"`
	}{Patterns: patterns, Suites: suites})
	if err != nil {
		return "", err
	}
	_, _ = hash.Write(encoded)
	for _, name := range []string{"go.mod", "go.sum", "go.work", "go.work.sum"} {
		value, readErr := os.ReadFile(filepath.Join(root, name))
		if readErr != nil {
			if os.IsNotExist(readErr) {
				continue
			}
			return "", readErr
		}
		_, _ = hash.Write([]byte(name))
		_, _ = hash.Write(value)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func uniqueStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	result := values[:0]
	for index, value := range values {
		if index == 0 || value != values[index-1] {
			result = append(result, value)
		}
	}
	return result
}

func commandEnvironment(overrides map[string]string) []string {
	environment := os.Environ()
	for key, value := range overrides {
		prefix := key + "="
		filtered := environment[:0]
		for _, existing := range environment {
			if !strings.HasPrefix(existing, prefix) {
				filtered = append(filtered, existing)
			}
		}
		environment = append(filtered, prefix+value)
	}
	return environment
}
