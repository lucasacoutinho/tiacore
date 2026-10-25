package tiacore

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Policy narrows or forces a plan. Its zero value plans every suite normally.
type Policy struct {
	// AllowedSuites restricts planning to these suite ids. Nil allows every suite;
	// a non-nil empty slice allows none.
	AllowedSuites                  []string
	ExpectedEnvironmentFingerprint *string
	ExpectedFingerprint            *string
	ForceFull                      bool
	// IgnoreChanges lists globs of changed files that never select a suite.
	IgnoreChanges []string
	// OnUnknownChange is "full" (also the empty default) or "ignore".
	OnUnknownChange string
}

// PlanInput is the input of CreateImpactPlan.
type PlanInput struct {
	Catalog                []Suite
	Changes                []string
	EnvironmentFingerprint string
	Fingerprint            string
	// Graph is the stored graph as JSON; nil or null means no graph exists.
	Graph  json.RawMessage
	Policy Policy
}

func catalogSuites(catalog []Suite) (map[string]Suite, error) {
	suites := make(map[string]Suite, len(catalog))
	for _, suite := range catalog {
		if _, exists := suites[suite.ID]; exists || isBlank(suite.ID) {
			return nil, fmt.Errorf("duplicate or empty TIA suite id: %s", suite.ID)
		}
		if _, err := normalizePath(suite.File); err != nil {
			return nil, fmt.Errorf("TIA protocol paths must be project-relative: %s", suite.File)
		}
		suites[suite.ID] = suite
	}
	for _, suite := range catalog {
		for _, dependency := range suite.DependsOn {
			if _, exists := suites[dependency]; !exists {
				return nil, fmt.Errorf("TIA suite %s depends on unknown suite %s", suite.ID, dependency)
			}
		}
	}
	return suites, nil
}

func sortedIDs(suites map[string]Suite) []string {
	ids := make([]string, 0, len(suites))
	for id := range suites {
		ids = append(ids, id)
	}
	sortUTF16(ids)
	return ids
}

func resourceLocks(suites map[string]Suite, selected []string) []string {
	locks := make([]string, 0)
	for _, id := range selected {
		locks = append(locks, suites[id].ResourceLocks...)
	}
	return sortedUnique(locks)
}

func planAll(suites map[string]Suite, changed []string, reason string) Plan {
	selected := sortedIDs(suites)
	reasons := make(map[string][]string, len(selected))
	for _, id := range selected {
		reasons[id] = []string{reason}
	}
	return Plan{
		Cached: []string{}, ChangedFiles: changed, Mode: "full", Protocol: ProtocolVersion,
		Reason: reason, Reasons: reasons, ResourceLocks: resourceLocks(suites, selected), Selected: selected,
	}
}

func pluralize(count int, noun string) string {
	if count == 1 {
		return fmt.Sprintf("%d %s", count, noun)
	}
	return fmt.Sprintf("%d %ss", count, noun)
}

// CreateImpactPlan plans which suites of a protocol v1 catalog must run for a
// change set. It returns an error for an invalid catalog, policy or changed path;
// a stored graph that is missing, invalid, incomplete or stale yields a full plan.
func CreateImpactPlan(input PlanInput) (Plan, error) {
	suites, err := catalogSuites(input.Catalog)
	if err != nil {
		return Plan{}, err
	}
	policy := input.Policy
	if policy.AllowedSuites != nil {
		allowed := make(map[string]bool, len(policy.AllowedSuites))
		for _, id := range policy.AllowedSuites {
			if _, exists := suites[id]; !exists {
				return Plan{}, fmt.Errorf("TIA policy allows unknown suite %s", id)
			}
			allowed[id] = true
		}
		for id := range suites {
			if !allowed[id] {
				delete(suites, id)
			}
		}
	}
	changed := make([]string, 0, len(input.Changes))
	for _, file := range input.Changes {
		normalized, err := normalizePath(file)
		if err != nil {
			return Plan{}, fmt.Errorf("TIA protocol paths must be project-relative: %s", file)
		}
		changed = append(changed, normalized)
	}
	changed = sortedUnique(changed)

	if policy.ForceFull {
		return planAll(suites, changed, "policy requires a full run"), nil
	}
	if len(input.Graph) == 0 || string(input.Graph) == "null" {
		return planAll(suites, changed, "no compatible impact graph found"), nil
	}
	graph, err := ParseImpactGraph(input.Graph)
	if err != nil {
		return planAll(suites, changed, "invalid impact graph: "+err.Error()), nil
	}
	if !graph.Complete {
		return planAll(suites, changed, "the previous impact graph is incomplete"), nil
	}
	if graph.Fingerprint != input.Fingerprint || (policy.ExpectedFingerprint != nil && graph.Fingerprint != *policy.ExpectedFingerprint) {
		return planAll(suites, changed, "project structure changed"), nil
	}
	if graph.EnvironmentFingerprint != input.EnvironmentFingerprint ||
		(policy.ExpectedEnvironmentFingerprint != nil && graph.EnvironmentFingerprint != *policy.ExpectedEnvironmentFingerprint) {
		return planAll(suites, changed, "execution environment changed"), nil
	}

	ignored := globMatcher(policy.IgnoreChanges...)
	active := make([]string, 0, len(changed))
	for _, file := range changed {
		if !ignored(file) {
			active = append(active, file)
		}
	}
	type invalidator struct {
		reason  string
		matches func(string) bool
	}
	invalidators := make([]invalidator, 0, len(graph.Invalidators))
	for _, item := range graph.Invalidators {
		invalidators = append(invalidators, invalidator{reason: item.Reason, matches: globMatcher(item.Pattern)})
	}

	graphFiles := make(map[string]string, len(graph.Suites))
	known := make(map[string]bool, len(graph.KnownSources)+len(graph.Observations)+len(graph.Suites))
	for _, source := range graph.KnownSources {
		known[source] = true
	}
	for _, suite := range graph.Suites {
		graphFiles[suite.ID] = suite.File
		known[suite.File] = true
	}
	dependencies := make(map[string]map[string]bool)
	for _, observation := range graph.Observations {
		known[observation.Source] = true
		if dependencies[observation.SuiteID] == nil {
			dependencies[observation.SuiteID] = make(map[string]bool)
		}
		dependencies[observation.SuiteID][observation.Source] = true
	}

	for _, file := range active {
		for _, item := range invalidators {
			if item.matches(file) {
				return planAll(suites, changed, item.reason+": "+file), nil
			}
		}
		if (policy.OnUnknownChange == "" || policy.OnUnknownChange == "full") && !known[file] {
			return planAll(suites, changed, "changed file is unknown to the impact graph: "+file), nil
		}
	}

	changeSet := make(map[string]bool, len(active))
	for _, file := range active {
		changeSet[file] = true
	}
	reasons := make(map[string]map[string]bool)
	addReason := func(id, reason string) {
		if reasons[id] == nil {
			reasons[id] = make(map[string]bool)
		}
		reasons[id][reason] = true
	}
	for id := range suites {
		if file, exists := graphFiles[id]; exists && changeSet[file] {
			addReason(id, "suite file changed: "+file)
		}
		for source := range dependencies[id] {
			if changeSet[source] {
				addReason(id, "observed dependency changed: "+source)
			}
		}
	}
	affected := make(map[string]bool, len(reasons))
	selected := make(map[string]bool, len(reasons))
	pending := make([]string, 0, len(reasons))
	for id := range reasons {
		affected[id] = true
		selected[id] = true
		pending = append(pending, id)
	}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		for _, need := range suites[current].DependsOn {
			if _, allowed := suites[need]; !allowed {
				continue
			}
			if !affected[need] {
				addReason(need, "dependency of "+current)
			}
			if !selected[need] {
				selected[need] = true
				pending = append(pending, need)
			}
		}
	}

	selectedIDs := make([]string, 0, len(selected))
	for id := range selected {
		selectedIDs = append(selectedIDs, id)
	}
	sortUTF16(selectedIDs)
	cached := make([]string, 0, len(suites))
	for _, id := range sortedIDs(suites) {
		if !selected[id] {
			cached = append(cached, id)
		}
	}
	planReasons := make(map[string][]string, len(selectedIDs))
	for _, id := range selectedIDs {
		list := make([]string, 0, len(reasons[id]))
		for reason := range reasons[id] {
			list = append(list, reason)
		}
		sortUTF16(list)
		planReasons[id] = list
	}
	mode, reason := "selective", pluralize(len(selectedIDs), "affected suite")
	if len(selectedIDs) == 0 {
		mode, reason = "skip", "no suites are affected"
	}
	return Plan{
		Cached: cached, ChangedFiles: changed, Mode: mode, Protocol: ProtocolVersion, Reason: reason,
		Reasons: planReasons, ResourceLocks: resourceLocks(suites, selectedIDs), Selected: selectedIDs,
	}, nil
}

// FreshRequested parses TIA_FRESH: 1, true, yes or on in any ASCII case.
func FreshRequested(value string) bool {
	switch strings.ToLower(asciiOnly(value)) {
	case "1", "true", "yes", "on":
		return value == asciiOnly(value)
	}
	return false
}

// asciiOnly drops non-ASCII bytes so that Unicode case folding cannot match.
func asciiOnly(value string) string {
	var out strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] < 0x80 {
			out.WriteByte(value[index])
		}
	}
	return out.String()
}
