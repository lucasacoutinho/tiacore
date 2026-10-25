package tiacore

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

var protocolLimits = struct {
	invalidators, knownSources, observations, relationsPerSuite, stringLength, suites int
}{10_000, 1_000_000, 1_000_000, 100_000, 8_192, 100_000}

var edgeKinds = map[string]bool{
	"capability": true, "configuration": true, "conservative": true, "database": true,
	"executed": true, "fixture": true, "import": true, "lazy": true, "route": true, "view": true,
}

var edgeConfidences = map[string]bool{"conservative": true, "exact": true, "inferred": true, "observed": true}

// jsWhitespace is ECMAScript's String.prototype.trim set, which differs from Unicode White_Space.
func isJSWhitespace(char rune) bool {
	switch char {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return char >= 0x2000 && char <= 0x200a
}

func isBlank(value string) bool {
	return strings.TrimFunc(value, isJSWhitespace) == ""
}

// ParseImpactGraph validates a protocol v1 graph and returns its canonical form.
func ParseImpactGraph(data []byte) (Graph, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return Graph{}, fmt.Errorf("TIA impact graph is not JSON: %w", err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return Graph{}, errors.New("TIA impact graph has trailing data")
	}
	return decodeGraph(value)
}

func checkObject(value any, label string, keys ...string) (map[string]any, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s Expected object", label)
	}
	allowed := make(map[string]bool, len(keys))
	for _, key := range keys {
		allowed[key] = true
	}
	names := make([]string, 0, len(object))
	for key := range object {
		names = append(names, key)
	}
	sort.Strings(names)
	for _, key := range names {
		if !allowed[key] {
			return nil, fmt.Errorf("%s.%s has an unknown field", label, key)
		}
	}
	return object, nil
}

func requiredField(object map[string]any, key, label string) (any, error) {
	value, exists := object[key]
	if !exists {
		return nil, fmt.Errorf("%s %s is required", label, key)
	}
	return value, nil
}

func decodeString(value any, label string, allowBlank bool) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s Expected string", label)
	}
	if utf16Length(text) > protocolLimits.stringLength {
		return "", fmt.Errorf("%s exceeds the limit of %d", label, protocolLimits.stringLength)
	}
	if !allowBlank && isBlank(text) {
		return "", fmt.Errorf("%s must not be empty", label)
	}
	return text, nil
}

func decodePath(value any, label string) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s Expected string", label)
	}
	normalized, err := normalizePath(text)
	if err != nil {
		return "", fmt.Errorf("%s must be project-relative: %s", label, text)
	}
	return normalized, nil
}

func decodeArray(value any, label string, limit int) ([]any, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s Expected array", label)
	}
	if len(items) > limit {
		return nil, fmt.Errorf("%s exceeds the limit of %d", label, limit)
	}
	return items, nil
}

func checkDistinct(keys []string, label string) error {
	seen := make(map[string]bool, len(keys))
	for _, key := range keys {
		if seen[key] {
			return fmt.Errorf("%s contains duplicate values", label)
		}
		seen[key] = true
	}
	return nil
}

func decodeStrings(value any, label string, limit int) ([]string, error) {
	items, err := decodeArray(value, label, limit)
	if err != nil {
		return nil, err
	}
	result := make([]string, len(items))
	for index, item := range items {
		if result[index], err = decodeString(item, fmt.Sprintf("%s[%d]", label, index), false); err != nil {
			return nil, err
		}
	}
	if err := checkDistinct(result, label); err != nil {
		return nil, err
	}
	sortUTF16(result)
	return result, nil
}

func decodeSuite(value any, label string) (Suite, error) {
	object, err := checkObject(value, label, "adapter", "dependsOn", "file", "id", "project", "resourceLocks", "tags")
	if err != nil {
		return Suite{}, err
	}
	var suite Suite
	for _, field := range []struct {
		key  string
		path bool
		into *string
	}{{"adapter", false, &suite.Adapter}, {"file", true, &suite.File}, {"id", false, &suite.ID}, {"project", false, &suite.Project}} {
		raw, err := requiredField(object, field.key, label)
		if err != nil {
			return Suite{}, err
		}
		if field.path {
			*field.into, err = decodePath(raw, label+"."+field.key)
		} else {
			*field.into, err = decodeString(raw, label+"."+field.key, false)
		}
		if err != nil {
			return Suite{}, err
		}
	}
	for _, field := range []struct {
		key  string
		into *[]string
	}{{"dependsOn", &suite.DependsOn}, {"resourceLocks", &suite.ResourceLocks}, {"tags", &suite.Tags}} {
		if raw, exists := object[field.key]; exists {
			if *field.into, err = decodeStrings(raw, label+"."+field.key, protocolLimits.relationsPerSuite); err != nil {
				return Suite{}, err
			}
		}
	}
	return suite, nil
}

func decodeObservation(value any, label string) (Observation, error) {
	object, err := checkObject(value, label, "confidence", "kind", "source", "suiteId")
	if err != nil {
		return Observation{}, err
	}
	var observation Observation
	confidence, err := requiredField(object, "confidence", label)
	if err != nil {
		return observation, err
	}
	if text, ok := confidence.(string); !ok || !edgeConfidences[text] {
		return observation, fmt.Errorf("%s.confidence Expected a known confidence", label)
	} else {
		observation.Confidence = text
	}
	kind, err := requiredField(object, "kind", label)
	if err != nil {
		return observation, err
	}
	if text, ok := kind.(string); !ok || !edgeKinds[text] {
		return observation, fmt.Errorf("%s.kind Expected a known edge kind", label)
	} else {
		observation.Kind = text
	}
	source, err := requiredField(object, "source", label)
	if err != nil {
		return observation, err
	}
	if observation.Source, err = decodePath(source, label+".source"); err != nil {
		return observation, err
	}
	suiteID, err := requiredField(object, "suiteId", label)
	if err != nil {
		return observation, err
	}
	observation.SuiteID, err = decodeString(suiteID, label+".suiteId", false)
	return observation, err
}

func observationKey(observation Observation) string {
	return strings.Join([]string{observation.SuiteID, observation.Source, observation.Kind, observation.Confidence}, "\x00")
}

func invalidatorKey(invalidator Invalidator) string {
	return invalidator.Pattern + "\x00" + invalidator.Reason
}

func decodeGraph(value any) (Graph, error) {
	const label = "TIA impact graph"
	object, err := checkObject(value, label, "complete", "environmentFingerprint", "fingerprint", "invalidators", "knownSources", "observations", "protocolVersion", "suites")
	if err != nil {
		return Graph{}, err
	}
	version, err := requiredField(object, "protocolVersion", label)
	if err != nil {
		return Graph{}, err
	}
	if number, ok := version.(json.Number); !ok || !isProtocolVersion(number) {
		return Graph{}, fmt.Errorf("%s protocolVersion is an unsupported TIA protocol version", label)
	}
	graph := Graph{ProtocolVersion: ProtocolVersion}
	complete, err := requiredField(object, "complete", label)
	if err != nil {
		return Graph{}, err
	}
	var ok bool
	if graph.Complete, ok = complete.(bool); !ok {
		return Graph{}, fmt.Errorf("%s complete Expected boolean", label)
	}
	environment, err := requiredField(object, "environmentFingerprint", label)
	if err != nil {
		return Graph{}, err
	}
	if graph.EnvironmentFingerprint, err = decodeString(environment, label+" environmentFingerprint", true); err != nil {
		return Graph{}, err
	}
	fingerprint, err := requiredField(object, "fingerprint", label)
	if err != nil {
		return Graph{}, err
	}
	if graph.Fingerprint, err = decodeString(fingerprint, label+" fingerprint", false); err != nil {
		return Graph{}, err
	}

	if raw, exists := object["invalidators"]; exists {
		items, err := decodeArray(raw, label+" invalidators", protocolLimits.invalidators)
		if err != nil {
			return Graph{}, err
		}
		keys := make([]string, 0, len(items))
		for index, item := range items {
			where := fmt.Sprintf("%s invalidators[%d]", label, index)
			entry, err := checkObject(item, where, "pattern", "reason")
			if err != nil {
				return Graph{}, err
			}
			var invalidator Invalidator
			for _, field := range []struct {
				key  string
				into *string
			}{{"pattern", &invalidator.Pattern}, {"reason", &invalidator.Reason}} {
				text, err := requiredField(entry, field.key, where)
				if err != nil {
					return Graph{}, err
				}
				if *field.into, err = decodeString(text, where+"."+field.key, false); err != nil {
					return Graph{}, err
				}
			}
			graph.Invalidators = append(graph.Invalidators, invalidator)
			keys = append(keys, invalidatorKey(invalidator))
		}
		if err := checkDistinct(keys, label+" invalidators"); err != nil {
			return Graph{}, err
		}
		sort.Slice(graph.Invalidators, func(left, right int) bool {
			return utf16Less(invalidatorKey(graph.Invalidators[left]), invalidatorKey(graph.Invalidators[right]))
		})
	}
	if raw, exists := object["knownSources"]; exists {
		items, err := decodeArray(raw, label+" knownSources", protocolLimits.knownSources)
		if err != nil {
			return Graph{}, err
		}
		for index, item := range items {
			source, err := decodePath(item, fmt.Sprintf("%s knownSources[%d]", label, index))
			if err != nil {
				return Graph{}, err
			}
			graph.KnownSources = append(graph.KnownSources, source)
		}
		if err := checkDistinct(graph.KnownSources, label+" knownSources"); err != nil {
			return Graph{}, err
		}
		sortUTF16(graph.KnownSources)
	}

	rawObservations, err := requiredField(object, "observations", label)
	if err != nil {
		return Graph{}, err
	}
	items, err := decodeArray(rawObservations, label+" observations", protocolLimits.observations)
	if err != nil {
		return Graph{}, err
	}
	graph.Observations = make([]Observation, 0, len(items))
	keys := make([]string, 0, len(items))
	for index, item := range items {
		observation, err := decodeObservation(item, fmt.Sprintf("%s observations[%d]", label, index))
		if err != nil {
			return Graph{}, err
		}
		graph.Observations = append(graph.Observations, observation)
		keys = append(keys, observationKey(observation))
	}
	if err := checkDistinct(keys, label+" observations"); err != nil {
		return Graph{}, err
	}

	rawSuites, err := requiredField(object, "suites", label)
	if err != nil {
		return Graph{}, err
	}
	items, err = decodeArray(rawSuites, label+" suites", protocolLimits.suites)
	if err != nil {
		return Graph{}, err
	}
	graph.Suites = make([]Suite, 0, len(items))
	ids := make([]string, 0, len(items))
	for index, item := range items {
		suite, err := decodeSuite(item, fmt.Sprintf("%s suites[%d]", label, index))
		if err != nil {
			return Graph{}, err
		}
		graph.Suites = append(graph.Suites, suite)
		ids = append(ids, suite.ID)
	}
	if err := checkDistinct(ids, label+" suites"); err != nil {
		return Graph{}, err
	}
	if err := checkSuiteRelations(graph); err != nil {
		return Graph{}, err
	}
	sort.Slice(graph.Observations, func(left, right int) bool {
		return utf16Less(observationKey(graph.Observations[left]), observationKey(graph.Observations[right]))
	})
	sort.Slice(graph.Suites, func(left, right int) bool { return utf16Less(graph.Suites[left].ID, graph.Suites[right].ID) })
	return graph, nil
}

func isProtocolVersion(number json.Number) bool {
	parsed, err := number.Float64()
	return err == nil && parsed == ProtocolVersion
}

func checkSuiteRelations(graph Graph) error {
	byID := make(map[string]Suite, len(graph.Suites))
	for _, suite := range graph.Suites {
		byID[suite.ID] = suite
	}
	for _, suite := range graph.Suites {
		for _, dependency := range suite.DependsOn {
			if _, exists := byID[dependency]; !exists {
				return fmt.Errorf("suite %s depends on unknown suite %s", suite.ID, dependency)
			}
		}
	}
	const (
		visiting = 1
		visited  = 2
	)
	state := make(map[string]int, len(byID))
	var cycleThrough func(id string) string
	cycleThrough = func(id string) string {
		switch state[id] {
		case visiting:
			return id
		case visited:
			return ""
		}
		state[id] = visiting
		for _, dependency := range byID[id].DependsOn {
			if cycle := cycleThrough(dependency); cycle != "" {
				return cycle
			}
		}
		state[id] = visited
		return ""
	}
	for _, suite := range graph.Suites {
		if cycle := cycleThrough(suite.ID); cycle != "" {
			return fmt.Errorf("suite dependency cycle includes %s", cycle)
		}
	}
	for _, observation := range graph.Observations {
		if _, exists := byID[observation.SuiteID]; !exists {
			return fmt.Errorf("observation references unknown suite %s", observation.SuiteID)
		}
	}
	return nil
}
