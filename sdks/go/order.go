package tiacore

import (
	"sort"
	"unicode/utf16"
)

// Every ordered collection in the protocol sorts by UTF-16 code unit so that all
// runtimes agree, including for text outside the Basic Multilingual Plane.

func isASCII(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] >= 0x80 {
			return false
		}
	}
	return true
}

func utf16Units(value string) []uint16 {
	return utf16.Encode([]rune(value))
}

func utf16Length(value string) int {
	if isASCII(value) {
		return len(value)
	}
	return len(utf16Units(value))
}

func utf16Less(left, right string) bool {
	if isASCII(left) && isASCII(right) {
		return left < right
	}
	a, b := utf16Units(left), utf16Units(right)
	for index := 0; index < len(a) && index < len(b); index++ {
		if a[index] != b[index] {
			return a[index] < b[index]
		}
	}
	return len(a) < len(b)
}

func sortUTF16(values []string) {
	sort.Slice(values, func(left, right int) bool { return utf16Less(values[left], values[right]) })
}

func sortedUnique(values []string) []string {
	sortUTF16(values)
	result := values[:0]
	for index, value := range values {
		if index == 0 || value != values[index-1] {
			result = append(result, value)
		}
	}
	return result
}
