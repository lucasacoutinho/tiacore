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
	EnvironmentFingerprintSuffix string
	ForceFull                    bool
	JSONPlan                     bool
	Stdout                       io.Writer
	Stderr                       io.Writer
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
