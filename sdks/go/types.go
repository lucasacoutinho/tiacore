package tiacore

import (
	"context"
	"io"
)

const (
	ProtocolVersion = 1
	stateVersion    = 1
)

type Suite struct {
	Adapter       string   `json:"adapter"`
	File          string   `json:"file"`
	ID            string   `json:"id"`
	Project       string   `json:"project"`
	DependsOn     []string `json:"dependsOn,omitempty"`
	ResourceLocks []string `json:"resourceLocks,omitempty"`
	Tags          []string `json:"tags,omitempty"`
}

type Observation struct {
	Confidence string `json:"confidence"`
	Kind       string `json:"kind"`
	Source     string `json:"source"`
	SuiteID    string `json:"suiteId"`
}

type Invalidator struct {
	Pattern string `json:"pattern"`
	Reason  string `json:"reason"`
}

type Graph struct {
	ProtocolVersion        int           `json:"protocolVersion"`
	Complete               bool          `json:"complete"`
	Fingerprint            string        `json:"fingerprint"`
	EnvironmentFingerprint string        `json:"environmentFingerprint"`
	KnownSources           []string      `json:"knownSources,omitempty"`
	Invalidators           []Invalidator `json:"invalidators,omitempty"`
	Suites                 []Suite       `json:"suites"`
	Observations           []Observation `json:"observations"`
}

type Plan struct {
	Cached        []string            `json:"cached"`
	ChangedFiles  []string            `json:"changedFiles"`
	Mode          string              `json:"mode"`
	Protocol      int                 `json:"protocolVersion"`
	Reason        string              `json:"reason"`
	Reasons       map[string][]string `json:"reasons"`
	ResourceLocks []string            `json:"resourceLocks"`
	Selected      []string            `json:"selected"`
}

type Result struct {
	Plan     Plan
	Packages []string
	Status   int
	Success  bool
}

type Options struct {
	Root                         string
	CacheDirectory               string
	GoBinary                     string
	PackagePatterns              []string
	Project                      string
	TestArguments                []string
	Environment                  map[string]string
	// EnvironmentAllowlist restricts which process environment variables enter
	// the cache fingerprint. When empty (the default), every variable except
	// shell bookkeeping enters the fingerprint. Go's build environment (GOOS,
	// GOARCH, CGO_ENABLED, GOVERSION, GOFLAGS, GOWORK) is always hashed.
	EnvironmentAllowlist         []string
	EnvironmentFingerprintSuffix string
	ForceFull                    bool
	// IgnoreChanges lists globs of changed files that never select a package.
	IgnoreChanges []string
	// OnUnknownChange is what a changed file the stored graph does not know
	// triggers: "full" (also the empty default) or "ignore".
	OnUnknownChange string
	JSONPlan        bool
	Stdout          io.Writer
	Stderr          io.Writer
}

type Runner struct {
	options Options
}

func New(options Options) *Runner {
	return &Runner{options: options}
}

func (runner *Runner) Run(ctx context.Context) Result {
	return runner.run(ctx)
}
