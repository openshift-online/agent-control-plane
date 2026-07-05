package application

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/ambient-code/platform/components/ambient-cli/internal/testhelper"
	"github.com/ambient-code/platform/components/ambient-sdk/go-sdk/types"
)

var testTime = time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)

func sampleApplication(id, name, repo, path, project string) types.Application {
	return types.Application{
		ObjectReference: types.ObjectReference{
			ID:        id,
			Kind:      "Application",
			Href:      "/api/ambient/v1/applications/" + id,
			CreatedAt: &testTime,
			UpdatedAt: &testTime,
		},
		Name:               name,
		SourceRepoURL:      repo,
		SourcePath:         path,
		DestinationProject: project,
		SyncStatus:         "Unknown",
		HealthStatus:       "Unknown",
	}
}

func TestListApplications_Success(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("expected GET, got %s", r.Method)
		}
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 2, Total: 2},
			Items: []types.Application{
				sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"),
				sampleApplication("app-2", "fleet-dev", "https://github.com/org/repo", "agents/dev/", "dev"),
			},
		})
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "list")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v\nstdout: %s\nstderr: %s", result.Err, result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "fleet-prod") {
		t.Errorf("expected fleet-prod in output, got: %s", result.Stdout)
	}
	if !strings.Contains(result.Stdout, "fleet-dev") {
		t.Errorf("expected fleet-dev in output, got: %s", result.Stdout)
	}
}

func TestListApplications_JSON(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 1, Total: 1},
			Items:    []types.Application{sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod")},
		})
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "list", "-o", "json")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v", result.Err)
	}
	var list types.ApplicationList
	if err := json.Unmarshal([]byte(result.Stdout), &list); err != nil {
		t.Fatalf("invalid JSON output: %v\n%s", err, result.Stdout)
	}
	if len(list.Items) != 1 {
		t.Errorf("expected 1 item, got %d", len(list.Items))
	}
}

func TestListApplications_Empty(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 0, Total: 0},
			Items:    []types.Application{},
		})
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "list")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v", result.Err)
	}
}

func TestGetApplication_Success(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 1, Total: 1},
			Items:    []types.Application{sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod")},
		})
	})
	srv.Handle("/api/ambient/v1/applications/app-1", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"))
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "get", "fleet-prod")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v\nstdout: %s\nstderr: %s", result.Err, result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "fleet-prod") {
		t.Errorf("expected fleet-prod in output, got: %s", result.Stdout)
	}
}

func TestGetApplication_JSON(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 1, Total: 1},
			Items:    []types.Application{sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod")},
		})
	})
	srv.Handle("/api/ambient/v1/applications/app-1", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"))
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "get", "fleet-prod", "-o", "json")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v", result.Err)
	}
	var app types.Application
	if err := json.Unmarshal([]byte(result.Stdout), &app); err != nil {
		t.Fatalf("invalid JSON output: %v", err)
	}
	if app.Name != "fleet-prod" {
		t.Errorf("expected name fleet-prod, got %s", app.Name)
	}
}

func TestGetApplication_MissingArg(t *testing.T) {
	srv := testhelper.NewServer(t)
	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "get")
	if result.Err == nil {
		t.Fatal("expected error for missing argument")
	}
}

func TestCreateApplication_Success(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		body, _ := io.ReadAll(r.Body)
		var req map[string]interface{}
		if err := json.Unmarshal(body, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		if req["name"] != "fleet-prod" {
			t.Errorf("expected name fleet-prod, got %v", req["name"])
		}
		if req["source_repo_url"] != "https://github.com/org/repo" {
			t.Errorf("expected source_repo_url, got %v", req["source_repo_url"])
		}
		if req["source_path"] != "agents/" {
			t.Errorf("expected source_path agents/, got %v", req["source_path"])
		}
		if req["destination_project"] != "prod" {
			t.Errorf("expected destination_project prod, got %v", req["destination_project"])
		}
		srv.RespondJSON(t, w, http.StatusCreated, sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"))
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "create",
		"--name", "fleet-prod",
		"--source-repo-url", "https://github.com/org/repo",
		"--source-path", "agents/",
		"--destination-project", "prod",
	)
	if result.Err != nil {
		t.Fatalf("unexpected error: %v\nstdout: %s\nstderr: %s", result.Err, result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "application/fleet-prod created") {
		t.Errorf("expected 'application/fleet-prod created', got: %s", result.Stdout)
	}
}

func TestCreateApplication_MissingName(t *testing.T) {
	srv := testhelper.NewServer(t)
	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "create",
		"--source-repo-url", "https://github.com/org/repo",
		"--source-path", "agents/",
		"--destination-project", "prod",
	)
	if result.Err == nil {
		t.Fatal("expected error for missing --name")
	}
	if !strings.Contains(result.Err.Error(), "--name is required") {
		t.Errorf("expected '--name is required' error, got: %v", result.Err)
	}
}

func TestCreateApplication_MissingRepoURL(t *testing.T) {
	srv := testhelper.NewServer(t)
	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "create",
		"--name", "fleet-prod",
		"--source-path", "agents/",
		"--destination-project", "prod",
	)
	if result.Err == nil {
		t.Fatal("expected error for missing --source-repo-url")
	}
	if !strings.Contains(result.Err.Error(), "--source-repo-url is required") {
		t.Errorf("expected '--source-repo-url is required' error, got: %v", result.Err)
	}
}

func TestCreateApplication_MissingSourcePath(t *testing.T) {
	srv := testhelper.NewServer(t)
	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "create",
		"--name", "fleet-prod",
		"--source-repo-url", "https://github.com/org/repo",
		"--destination-project", "prod",
	)
	if result.Err == nil {
		t.Fatal("expected error for missing --source-path")
	}
}

func TestCreateApplication_MissingProject(t *testing.T) {
	srv := testhelper.NewServer(t)
	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "create",
		"--name", "fleet-prod",
		"--source-repo-url", "https://github.com/org/repo",
		"--source-path", "agents/",
	)
	if result.Err == nil {
		t.Fatal("expected error for missing --destination-project")
	}
}

func TestCreateApplication_JSON(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusCreated, sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"))
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "create",
		"--name", "fleet-prod",
		"--source-repo-url", "https://github.com/org/repo",
		"--source-path", "agents/",
		"--destination-project", "prod",
		"-o", "json",
	)
	if result.Err != nil {
		t.Fatalf("unexpected error: %v", result.Err)
	}
	var app types.Application
	if err := json.Unmarshal([]byte(result.Stdout), &app); err != nil {
		t.Fatalf("invalid JSON output: %v", err)
	}
}

func TestUpdateApplication_Success(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 1, Total: 1},
			Items:    []types.Application{sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod")},
		})
	})
	srv.Handle("/api/ambient/v1/applications/app-1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			body, _ := io.ReadAll(r.Body)
			var patch map[string]interface{}
			if err := json.Unmarshal(body, &patch); err != nil {
				t.Fatalf("unmarshal patch: %v", err)
			}
			if patch["auto_sync"] != true {
				t.Errorf("expected auto_sync=true in patch, got %v", patch["auto_sync"])
			}
		}
		srv.RespondJSON(t, w, http.StatusOK, sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"))
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "update", "fleet-prod", "--auto-sync")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v\nstdout: %s\nstderr: %s", result.Err, result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "application/fleet-prod updated") {
		t.Errorf("expected 'application/fleet-prod updated', got: %s", result.Stdout)
	}
}

func TestUpdateApplication_MissingArg(t *testing.T) {
	srv := testhelper.NewServer(t)
	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "update")
	if result.Err == nil {
		t.Fatal("expected error for missing argument")
	}
}

func TestDeleteApplication_Success(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 1, Total: 1},
			Items:    []types.Application{sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod")},
		})
	})
	srv.Handle("/api/ambient/v1/applications/app-1", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			srv.RespondJSON(t, w, http.StatusOK, sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "delete", "fleet-prod", "--confirm")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v\nstdout: %s\nstderr: %s", result.Err, result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "application/fleet-prod deleted") {
		t.Errorf("expected 'application/fleet-prod deleted', got: %s", result.Stdout)
	}
}

func TestDeleteApplication_MissingConfirm(t *testing.T) {
	srv := testhelper.NewServer(t)
	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "delete", "fleet-prod")
	if result.Err == nil {
		t.Fatal("expected error for missing --confirm")
	}
	if !strings.Contains(result.Err.Error(), "--confirm") {
		t.Errorf("expected '--confirm' in error, got: %v", result.Err)
	}
}

func TestDeleteApplication_MissingArg(t *testing.T) {
	srv := testhelper.NewServer(t)
	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "delete")
	if result.Err == nil {
		t.Fatal("expected error for missing argument")
	}
}

func TestSyncApplication_Success(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 1, Total: 1},
			Items:    []types.Application{sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod")},
		})
	})
	srv.Handle("/api/ambient/v1/applications/app-1/sync", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		srv.RespondJSON(t, w, http.StatusOK, sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"))
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "sync", "fleet-prod")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v\nstdout: %s\nstderr: %s", result.Err, result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "sync triggered") {
		t.Errorf("expected 'sync triggered' in output, got: %s", result.Stdout)
	}
}

func TestRefreshApplication_Success(t *testing.T) {
	srv := testhelper.NewServer(t)
	srv.Handle("/api/ambient/v1/applications", func(w http.ResponseWriter, r *http.Request) {
		srv.RespondJSON(t, w, http.StatusOK, types.ApplicationList{
			ListMeta: types.ListMeta{Kind: "ApplicationList", Page: 1, Size: 1, Total: 1},
			Items:    []types.Application{sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod")},
		})
	})
	srv.Handle("/api/ambient/v1/applications/app-1/refresh", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		srv.RespondJSON(t, w, http.StatusOK, sampleApplication("app-1", "fleet-prod", "https://github.com/org/repo", "agents/", "prod"))
	})

	testhelper.Configure(t, srv.URL)
	result := testhelper.Run(t, Cmd, "refresh", "fleet-prod")
	if result.Err != nil {
		t.Fatalf("unexpected error: %v\nstdout: %s\nstderr: %s", result.Err, result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "refreshed") {
		t.Errorf("expected 'refreshed' in output, got: %s", result.Stdout)
	}
}
