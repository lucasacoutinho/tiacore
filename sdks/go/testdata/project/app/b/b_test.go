package b

import "testing"

func TestValue(t *testing.T) {
	if Value() != "b" {
		t.Fatalf("Value() = %q, want b", Value())
	}
}
