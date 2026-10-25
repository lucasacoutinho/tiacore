package tiacore

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"sync"
)

// maxResultLine bounds the bytes kept for one line. A package result is far
// shorter; a longer line is test output and is dropped unread.
const maxResultLine = 64 << 10

type resultMask uint8

const (
	sawPassed resultMask = 1 << iota
	sawFailed
)

// packageResults is what go test said about a set of packages. It keeps one
// small flag set per package, never the output it was read from.
type packageResults struct {
	mutex   sync.Mutex
	seen    map[string]resultMask
	known   map[string]struct{}
	streams []*resultStream
}

func newPackageResults(importPaths []string) *packageResults {
	known := make(map[string]struct{}, len(importPaths))
	for _, importPath := range importPaths {
		known[importPath] = struct{}{}
	}
	return &packageResults{seen: make(map[string]resultMask), known: known}
}

func (results *packageResults) record(importPath string, mask resultMask) {
	if _, exists := results.known[importPath]; !exists {
		return
	}
	results.mutex.Lock()
	results.seen[importPath] |= mask
	results.mutex.Unlock()
}

// outcome is passed or failed when go test reported that and nothing else for
// the package, and unknown otherwise: not reported, or reported both ways.
func (results *packageResults) outcome(importPath string) string {
	results.mutex.Lock()
	defer results.mutex.Unlock()
	switch results.seen[importPath] {
	case sawPassed:
		return outcomePassed
	case sawFailed:
		return outcomeFailed
	}
	return outcomeUnknown
}

// tee returns the writers go test's output goes to: the originals, with every
// byte also read for package results. Two streams that share one writer keep
// sharing one, so their output stays serialised as it was.
func (results *packageResults) tee(stdout, stderr io.Writer) (io.Writer, io.Writer) {
	out := results.stream(stdout)
	if sameWriter(stdout, stderr) {
		return out, out
	}
	return out, results.stream(stderr)
}

func (results *packageResults) stream(destination io.Writer) io.Writer {
	stream := &resultStream{results: results}
	results.streams = append(results.streams, stream)
	return io.MultiWriter(destination, stream)
}

// finish reads the last line of each stream when go test did not end it with a newline.
func (results *packageResults) finish() {
	for _, stream := range results.streams {
		stream.endLine()
	}
}

func sameWriter(left, right io.Writer) (same bool) {
	defer func() {
		if recover() != nil {
			same = false
		}
	}()
	return left == right
}

// resultStream splits what is written to it into lines and reads each one.
// It never fails a write, so it cannot disturb the output it watches.
type resultStream struct {
	results  *packageResults
	line     []byte
	overflow bool
}

func (stream *resultStream) Write(data []byte) (int, error) {
	remaining := data
	for len(remaining) > 0 {
		newline := bytes.IndexByte(remaining, '\n')
		if newline < 0 {
			stream.extend(remaining)
			break
		}
		stream.extend(remaining[:newline])
		stream.endLine()
		remaining = remaining[newline+1:]
	}
	return len(data), nil
}

func (stream *resultStream) extend(part []byte) {
	if stream.overflow {
		return
	}
	if len(stream.line)+len(part) > maxResultLine {
		stream.overflow = true
		stream.line = stream.line[:0]
		return
	}
	stream.line = append(stream.line, part...)
}

func (stream *resultStream) endLine() {
	if !stream.overflow {
		stream.results.read(bytes.TrimSuffix(stream.line, []byte{'\r'}))
	}
	stream.line = stream.line[:0]
	stream.overflow = false
}

const (
	passedPrefix  = "ok  \t"
	failedPrefix  = "FAIL\t"
	noTestsPrefix = "?   \t"
	buildFailed   = " [build failed]"
	setupFailed   = " [setup failed]"
)

// read records the package result a line states, if it states one: go test's
// own `ok  \t<package>\t...`, `FAIL\t<package>...` and `?   \t<package>\t[no test
// files]` lines, or a package-level `go test -json` event. A package with no
// test files was still built, and a build failure prints a FAIL line, so the
// `?` line is a pass.
func (results *packageResults) read(line []byte) {
	switch {
	case len(line) == 0:
	case line[0] == '{':
		results.readEvent(line)
	case bytes.HasPrefix(line, []byte(passedPrefix)):
		results.record(resultPackage(string(line[len(passedPrefix):])), sawPassed)
	case bytes.HasPrefix(line, []byte(noTestsPrefix)):
		results.record(resultPackage(string(line[len(noTestsPrefix):])), sawPassed)
	case bytes.HasPrefix(line, []byte(failedPrefix)):
		results.record(resultPackage(string(line[len(failedPrefix):])), sawFailed)
	}
}

// resultPackage is the import path that starts what follows a result's tab.
func resultPackage(rest string) string {
	importPath, _, _ := strings.Cut(rest, "\t")
	importPath = strings.TrimSuffix(importPath, buildFailed)
	return strings.TrimSuffix(importPath, setupFailed)
}

type packageEvent struct {
	Action  string `json:"Action"`
	Package string `json:"Package"`
	Test    string `json:"Test"`
}

func (results *packageResults) readEvent(line []byte) {
	// Most events of a -json run are about tests or output; skip them unparsed.
	if !bytes.Contains(line, []byte(`"Action":"pass"`)) && !bytes.Contains(line, []byte(`"Action":"fail"`)) &&
		!bytes.Contains(line, []byte(`"Action":"skip"`)) {
		return
	}
	if bytes.Contains(line, []byte(`"Test":`)) {
		return
	}
	var event packageEvent
	if err := json.Unmarshal(line, &event); err != nil || event.Test != "" {
		return
	}
	switch event.Action {
	case "pass", "skip":
		results.record(event.Package, sawPassed)
	case "fail":
		results.record(event.Package, sawFailed)
	}
}
