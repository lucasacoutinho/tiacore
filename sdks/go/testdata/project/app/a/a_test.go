package a

import "testing"

func TestValue(t *testing.T) {
	if Value() != "a" {
		t.Fatalf("Value() = %q, want a", Value())
	}
}
