package output

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

// PrintMetadata prints a JSON-encoded map of key-value pairs under a heading.
func PrintMetadata(w io.Writer, heading, jsonStr string) {
	if jsonStr == "" || jsonStr == "{}" {
		return
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(jsonStr), &m); err != nil {
		return
	}
	if len(m) == 0 {
		return
	}
	fmt.Fprintf(w, "%s:\n", heading)
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "  %s: %s\n", k, m[k])
	}
}
