package reconciler

import (
	"encoding/json"
	"testing"

	"github.com/rs/zerolog"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func newTestPodSyncer() *PodStatusSyncer {
	return &PodStatusSyncer{
		logger: zerolog.Nop(),
	}
}

func makePod(containerStatuses []interface{}, initContainerStatuses []interface{}) *unstructured.Unstructured {
	status := map[string]interface{}{}
	if containerStatuses != nil {
		status["containerStatuses"] = containerStatuses
	}
	if initContainerStatuses != nil {
		status["initContainerStatuses"] = initContainerStatuses
	}
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"status": status,
		},
	}
}

func TestBuildFailureConditions_OOMKilled(t *testing.T) {
	s := newTestPodSyncer()
	pod := makePod([]interface{}{
		map[string]interface{}{
			"name": "runner",
			"state": map[string]interface{}{
				"terminated": map[string]interface{}{
					"reason":   "OOMKilled",
					"exitCode": int64(137),
				},
			},
		},
	}, nil)

	result := s.buildFailureConditions(pod)
	if result == "" {
		t.Fatal("expected non-empty conditions")
	}

	var conditions []map[string]interface{}
	if err := json.Unmarshal([]byte(result), &conditions); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(conditions) != 1 {
		t.Fatalf("expected 1 condition, got %d", len(conditions))
	}
	if conditions[0]["reason"] != "OOMKilled" {
		t.Errorf("expected reason OOMKilled, got %v", conditions[0]["reason"])
	}
	if conditions[0]["type"] != "ContainerFailed" {
		t.Errorf("expected type ContainerFailed, got %v", conditions[0]["type"])
	}
}

func TestBuildFailureConditions_CrashLoopBackOff(t *testing.T) {
	s := newTestPodSyncer()
	pod := makePod([]interface{}{
		map[string]interface{}{
			"name": "runner",
			"state": map[string]interface{}{
				"waiting": map[string]interface{}{
					"reason": "CrashLoopBackOff",
				},
			},
		},
	}, nil)

	result := s.buildFailureConditions(pod)
	if result == "" {
		t.Fatal("expected non-empty conditions")
	}

	var conditions []map[string]interface{}
	if err := json.Unmarshal([]byte(result), &conditions); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if conditions[0]["reason"] != "StartupFailed" {
		t.Errorf("expected reason StartupFailed, got %v", conditions[0]["reason"])
	}
	msg, _ := conditions[0]["message"].(string)
	if msg != "Session failed to start" {
		t.Errorf("expected fallback message, got %q", msg)
	}
}

func TestBuildFailureConditions_ErrorExitCode(t *testing.T) {
	s := newTestPodSyncer()
	pod := makePod([]interface{}{
		map[string]interface{}{
			"name": "runner",
			"state": map[string]interface{}{
				"terminated": map[string]interface{}{
					"reason":   "Error",
					"exitCode": int64(1),
					"message":  "custom error message",
				},
			},
		},
	}, nil)

	result := s.buildFailureConditions(pod)
	var conditions []map[string]interface{}
	if err := json.Unmarshal([]byte(result), &conditions); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if conditions[0]["message"] != "custom error message" {
		t.Errorf("expected custom message, got %v", conditions[0]["message"])
	}
}

func TestBuildFailureConditions_SuccessfulPod(t *testing.T) {
	s := newTestPodSyncer()
	pod := makePod([]interface{}{
		map[string]interface{}{
			"name": "runner",
			"state": map[string]interface{}{
				"running": map[string]interface{}{},
			},
		},
	}, nil)

	result := s.buildFailureConditions(pod)
	if result != "" {
		t.Errorf("expected empty conditions for healthy pod, got %q", result)
	}
}

func TestBuildFailureConditions_InitContainerFailure(t *testing.T) {
	s := newTestPodSyncer()
	pod := makePod(nil, []interface{}{
		map[string]interface{}{
			"name": "init",
			"state": map[string]interface{}{
				"waiting": map[string]interface{}{
					"reason": "ImagePullBackOff",
				},
			},
		},
	})

	result := s.buildFailureConditions(pod)
	if result == "" {
		t.Fatal("expected non-empty conditions for init container failure")
	}

	var conditions []map[string]interface{}
	if err := json.Unmarshal([]byte(result), &conditions); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if conditions[0]["reason"] != "StartupFailed" {
		t.Errorf("expected reason StartupFailed, got %v", conditions[0]["reason"])
	}
}

func TestBuildFailureConditions_NoStatuses(t *testing.T) {
	s := newTestPodSyncer()
	pod := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"status": map[string]interface{}{},
		},
	}

	result := s.buildFailureConditions(pod)
	if result != "" {
		t.Errorf("expected empty conditions for pod with no statuses, got %q", result)
	}
}
