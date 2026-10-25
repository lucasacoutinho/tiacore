package tiacore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func vectorPath(name string) string {
	return filepath.Join("..", "..", "docs", "protocol", "conformance", "protocol", "v1", name)
}

func loadVectors(t *testing.T, name string, into any) {
	t.Helper()
	data, err := os.ReadFile(vectorPath(name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

type vectorPolicy struct {
	AllowedSuites                  []string `json:"allowedSuites"`
	ExpectedEnvironmentFingerprint *string  `json:"expectedEnvironmentFingerprint"`
	ExpectedFingerprint            *string  `json:"expectedFingerprint"`
	ForceFull                      bool     `json:"forceFull"`
	IgnoreChanges                  []string `json:"ignoreChanges"`
	OnUnknownChange                string   `json:"onUnknownChange"`
}

func (policy *vectorPolicy) toPolicy() Policy {
	if policy == nil {
		return Policy{}
	}
	return Policy{
		AllowedSuites:                  policy.AllowedSuites,
		ExpectedEnvironmentFingerprint: policy.ExpectedEnvironmentFingerprint,
		ExpectedFingerprint:            policy.ExpectedFingerprint,
		ForceFull:                      policy.ForceFull,
		IgnoreChanges:                  policy.IgnoreChanges,
		OnUnknownChange:                policy.OnUnknownChange,
	}
}

func marshal(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestSharedPlanningVectors(t *testing.T) {
	var vectors struct {
		Catalog []Suite         `json:"catalog"`
		Graph   json.RawMessage `json:"graph"`
		Vectors []struct {
			Name                   string        `json:"name"`
			Changes                []string      `json:"changes"`
			EnvironmentFingerprint string        `json:"environmentFingerprint"`
			Fingerprint            string        `json:"fingerprint"`
			Policy                 *vectorPolicy `json:"policy"`
			Expected               Plan          `json:"expected"`
		} `json:"vectors"`
	}
	loadVectors(t, "plans.json", &vectors)
	if len(vectors.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, vector := range vectors.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			plan, err := CreateImpactPlan(PlanInput{
				Catalog: vectors.Catalog, Changes: vector.Changes,
				EnvironmentFingerprint: vector.EnvironmentFingerprint, Fingerprint: vector.Fingerprint,
				Graph: vectors.Graph, Policy: vector.Policy.toPolicy(),
			})
			if err != nil {
				t.Fatal(err)
			}
			if got, want := marshal(t, plan), marshal(t, vector.Expected); got != want {
				t.Fatalf("plan = %s\nwant   %s", got, want)
			}
		})
	}
}

func TestGeneratedPlanningVectors(t *testing.T) {
	var vectors struct {
		Cases []struct {
			Name                   string          `json:"name"`
			Catalog                []Suite         `json:"catalog"`
			Changes                []string        `json:"changes"`
			EnvironmentFingerprint string          `json:"environmentFingerprint"`
			Fingerprint            string          `json:"fingerprint"`
			Graph                  json.RawMessage `json:"graph"`
			Policy                 *vectorPolicy   `json:"policy"`
			Expected               *Plan           `json:"expected"`
			ExpectedError          bool            `json:"expectedError"`
			ExpectedReasonPrefix   string          `json:"expectedReasonPrefix"`
		} `json:"cases"`
	}
	loadVectors(t, "generated-plans.json", &vectors)
	if len(vectors.Cases) < 300 {
		t.Fatalf("only %d generated cases", len(vectors.Cases))
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			plan, err := CreateImpactPlan(PlanInput{
				Catalog: vector.Catalog, Changes: vector.Changes,
				EnvironmentFingerprint: vector.EnvironmentFingerprint, Fingerprint: vector.Fingerprint,
				Graph: vector.Graph, Policy: vector.Policy.toPolicy(),
			})
			if vector.ExpectedError {
				if err == nil {
					t.Fatalf("expected an error, got %s", marshal(t, plan))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			expected := *vector.Expected
			if vector.ExpectedReasonPrefix != "" {
				if !strings.HasPrefix(plan.Reason, vector.ExpectedReasonPrefix) {
					t.Fatalf("reason = %q, want prefix %q", plan.Reason, vector.ExpectedReasonPrefix)
				}
				expected.Reason = plan.Reason
				for id := range expected.Reasons {
					expected.Reasons[id] = []string{plan.Reason}
				}
			}
			if got, want := marshal(t, plan), marshal(t, expected); got != want {
				t.Fatalf("plan = %s\nwant   %s", got, want)
			}
		})
	}
}

func TestInvalidGraphVectors(t *testing.T) {
	var vectors struct {
		Vectors []struct {
			Name          string          `json:"name"`
			ErrorIncludes string          `json:"errorIncludes"`
			Graph         json.RawMessage `json:"graph"`
		} `json:"vectors"`
	}
	loadVectors(t, "invalid-graphs.json", &vectors)
	for _, vector := range vectors.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			_, err := ParseImpactGraph(vector.Graph)
			if err == nil || !strings.Contains(err.Error(), vector.ErrorIncludes) {
				t.Fatalf("error = %v, want it to include %q", err, vector.ErrorIncludes)
			}
		})
	}
}

func TestCanonicalizationVector(t *testing.T) {
	var vector struct {
		Input    json.RawMessage `json:"input"`
		Expected json.RawMessage `json:"expected"`
	}
	loadVectors(t, "canonicalization.json", &vector)
	graph, err := ParseImpactGraph(vector.Input)
	if err != nil {
		t.Fatal(err)
	}
	var expected Graph
	if err := json.Unmarshal(vector.Expected, &expected); err != nil {
		t.Fatal(err)
	}
	if got, want := marshal(t, graph), marshal(t, expected); got != want {
		t.Fatalf("graph = %s\nwant    %s", got, want)
	}
}

func TestNormalizePath(t *testing.T) {
	accepted := map[string]string{
		"./a//b\\c/":        "a/b/c",
		"a/":                "a",
		"a/./b/../c":        "a/c",
		"a/b://c":           "a/b:/c",
		"src/\U0001F600.go": "src/\U0001F600.go",
	}
	for value, want := range accepted {
		if got, err := normalizePath(value); err != nil || got != want {
			t.Errorf("normalizePath(%q) = %q, %v; want %q", value, got, err, want)
		}
	}
	for _, value := range []string{
		"", ".", "x/../", "../a", "a/../../b", "/abs", `C:\a`, "https://example.test/a",
		"a\x00b", strings.Repeat("a", 4097),
	} {
		if _, err := normalizePath(value); err == nil {
			t.Errorf("normalizePath(%q) was accepted", value)
		}
	}
}

func TestOrderingFollowsUTF16CodeUnits(t *testing.T) {
	values := []string{"\uFF21", "\U0001F600", "b", "a"}
	sortUTF16(values)
	if want := []string{"a", "b", "\U0001F600", "\uFF21"}; !reflect.DeepEqual(values, want) {
		t.Fatalf("sorted = %q, want %q", values, want)
	}
}

func TestGlobSubsetFollowsPicomatch(t *testing.T) {
	for _, item := range []struct {
		pattern, path string
		want          bool
	}{
		{"a/**", "a", true}, {"a/**", "a/b/c", true}, {"a/**", "ab/c", false},
		{"**/x.ts", "x.ts", true}, {"**/x.ts", "a/x.ts", true}, {"*.ts", "a/x.ts", false},
		{"*.ts", ".x.ts", true}, {"a/*", "a/b/c", false}, {"a/**/c", "a/c", true},
		{"**a", "x/a", false}, {"?", "/", false}, {"requirements*.txt", "requirements.txt", true},
		{"{a,b}.ts", "b.ts", true}, {"[ab].ts", "c.ts", false}, {"vendor/**", "vendor/x/y.go", true},
		{"go.mod", "sub/go.mod", false},
	} {
		if got := globMatcher(item.pattern)(item.path); got != item.want {
			t.Errorf("glob %q on %q = %v, want %v", item.pattern, item.path, got, item.want)
		}
	}
}

func TestFreshRequestedAcceptsOneTrueYesOnInAnyCase(t *testing.T) {
	for _, value := range []string{"1", "true", "TRUE", "True", "yes", "YES", "on", "On"} {
		if !FreshRequested(value) {
			t.Errorf("FreshRequested(%q) = false", value)
		}
	}
	for _, value := range []string{"", "0", "false", "no", "off", " 1", "1 ", "2", "y", "yes\u017F", "tru\u0435"} {
		if FreshRequested(value) {
			t.Errorf("FreshRequested(%q) = true", value)
		}
	}
}
