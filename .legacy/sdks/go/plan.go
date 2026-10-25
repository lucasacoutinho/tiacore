package tiacore

import (
	"fmt"
	"sort"
)

func createPlan(graph Graph, previous *Graph, changed []string, forceFull bool) Plan {
	normalizedChanges := make([]string, 0, len(changed))
	for _, file := range changed {
		normalized, err := normalizePath(file)
		if err != nil {
			return fullPlan(graph.Suites, nil, "changed path is unsafe or incompatible")
		}
		normalizedChanges = append(normalizedChanges, normalized)
	}
	changed = sortedUnique(normalizedChanges)
	if forceFull {
		return fullPlan(graph.Suites, changed, "full run requested")
	}
	if previous == nil {
		return fullPlan(graph.Suites, changed, "no compatible impact state exists")
	}
	if previous.ProtocolVersion != ProtocolVersion || !previous.Complete {
		return fullPlan(graph.Suites, changed, "impact graph is incomplete or incompatible")
	}
	if previous.EnvironmentFingerprint != graph.EnvironmentFingerprint {
		return fullPlan(graph.Suites, changed, "execution environment changed")
	}
	if previous.Fingerprint != graph.Fingerprint {
		return fullPlan(graph.Suites, changed, "project structure changed")
	}
	for _, invalidator := range previous.Invalidators {
		for _, file := range changed {
			if matchesInvalidator(invalidator.Pattern, file) {
				return fullPlan(graph.Suites, changed, fmt.Sprintf("%s: %s", invalidator.Reason, file))
			}
		}
	}

	suiteByID := make(map[string]Suite, len(graph.Suites))
	testFiles := make(map[string]string, len(graph.Suites))
	for _, suite := range graph.Suites {
		suiteByID[suite.ID] = suite
		testFiles[suite.File] = suite.ID
	}
	known := make(map[string]struct{}, len(previous.KnownSources))
	for _, source := range previous.KnownSources {
		known[source] = struct{}{}
	}
	observations := make(map[string][]Observation)
	for _, observation := range previous.Observations {
		observations[observation.Source] = append(observations[observation.Source], observation)
	}
	selected := make(map[string]struct{})
	reasons := make(map[string][]string)
	for _, file := range changed {
		if suiteID, exists := testFiles[file]; exists {
			selected[suiteID] = struct{}{}
			reasons[suiteID] = append(reasons[suiteID], "suite file changed: "+file)
		}
		if edges := observations[file]; len(edges) > 0 {
			for _, edge := range edges {
				if _, exists := suiteByID[edge.SuiteID]; !exists {
					continue
				}
				selected[edge.SuiteID] = struct{}{}
				reasons[edge.SuiteID] = append(reasons[edge.SuiteID], "observed dependency changed: "+file)
			}
			continue
		}
		if _, exists := known[file]; !exists {
			return fullPlan(graph.Suites, changed, "changed file is unknown to the impact graph: "+file)
		}
	}

	selectedIDs := make([]string, 0, len(selected))
	for id := range selected {
		selectedIDs = append(selectedIDs, id)
	}
	sort.Strings(selectedIDs)
	cached := make([]string, 0, len(graph.Suites)-len(selectedIDs))
	for _, suite := range graph.Suites {
		if _, exists := selected[suite.ID]; !exists {
			cached = append(cached, suite.ID)
		}
	}
	for id := range reasons {
		reasons[id] = sortedUnique(reasons[id])
	}
	mode := "selective"
	reason := fmt.Sprintf("%d affected suites", len(selectedIDs))
	if len(selectedIDs) == 0 {
		mode = "skip"
		reason = "no suites are affected"
	}
	return Plan{Cached: cached, ChangedFiles: changed, Mode: mode, Protocol: ProtocolVersion, Reason: reason, Reasons: reasons, ResourceLocks: resourceLocks(graph.Suites, selected), Selected: selectedIDs}
}

func fullPlan(suites []Suite, changed []string, reason string) Plan {
	selected := make([]string, 0, len(suites))
	reasons := make(map[string][]string, len(suites))
	for _, suite := range suites {
		selected = append(selected, suite.ID)
		reasons[suite.ID] = []string{reason}
	}
	sort.Strings(selected)
	selectedSet := make(map[string]struct{}, len(selected))
	for _, id := range selected {
		selectedSet[id] = struct{}{}
	}
	return Plan{Cached: []string{}, ChangedFiles: changed, Mode: "full", Protocol: ProtocolVersion, Reason: reason, Reasons: reasons, ResourceLocks: resourceLocks(suites, selectedSet), Selected: selected}
}

func resourceLocks(suites []Suite, selected map[string]struct{}) []string {
	locks := make([]string, 0)
	for _, suite := range suites {
		if _, exists := selected[suite.ID]; exists {
			locks = append(locks, suite.ResourceLocks...)
		}
	}
	return sortedUnique(locks)
}

func sortedUnique(values []string) []string {
	sort.Strings(values)
	result := values[:0]
	for index, value := range values {
		if index == 0 || value != values[index-1] {
			result = append(result, value)
		}
	}
	return result
}
