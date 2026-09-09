package reconciler

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestManagedRunnerAdoptsOneProcessPerGeneration(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	directory := t.TempDir()
	statePath := filepath.Join(directory, "state")
	scriptPath := filepath.Join(directory, "launcher.py")
	script := strings.ReplaceAll(managedRunnerScript, "/sandbox/workspace/.acp-runtime", statePath)
	if err := os.WriteFile(scriptPath, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	generation := "0123456789abcdef0123456789abcdef"
	marker := filepath.Join(directory, "invocations")
	command := []string{python, "-c", "import pathlib,time; p=pathlib.Path(" + strconvQuote(marker) + "); p.write_text(p.read_text()+'x' if p.exists() else 'x'); time.sleep(.2)"}
	run := func(action string, extra ...string) managedProcessState {
		t.Helper()
		args := append([]string{scriptPath, action, generation}, extra...)
		output, err := exec.Command(python, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("launcher: %v: %s", err, output)
		}
		var state managedProcessState
		if err := json.Unmarshal(output, &state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	if state := run("start", command...); state.State != "running" {
		t.Fatalf("first launch: %+v", state)
	}
	if state := run("start", command...); state.State != "running" {
		t.Fatalf("duplicate launch: %+v", state)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		state := run("status")
		if state.State == "exited" {
			if state.ExitCode != 0 {
				t.Fatalf("runner exited %d", state.ExitCode)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runner did not exit")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if state := run("start", command...); state.State != "exited" {
		t.Fatal("completed generation restarted")
	}
	content, err := os.ReadFile(marker)
	if err != nil || string(content) != "x" {
		t.Fatalf("duplicate task execution: %q %v", content, err)
	}
}

func strconvQuote(value string) string { encoded, _ := json.Marshal(value); return string(encoded) }
