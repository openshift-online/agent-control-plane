package openshell

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/go-git/go-billy/v5/memfs"
	billyutil "github.com/go-git/go-billy/v5/util"
)

func TestValidatePayloadPath(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{name: "valid absolute path", path: "/sandbox/.claude/CLAUDE.md", wantErr: false},
		{name: "valid nested path", path: "/sandbox/workspace/src/main.go", wantErr: false},
		{name: "valid path with hyphens and underscores", path: "/sandbox/my-file_v2.txt", wantErr: false},
		{name: "empty path", path: "", wantErr: true},
		{name: "relative path", path: "sandbox/file.txt", wantErr: true},
		{name: "directory traversal", path: "/sandbox/../etc/passwd", wantErr: true},
		{name: "double dot in middle", path: "/sandbox/foo/../bar", wantErr: true},
		{name: "shell injection semicolon", path: "/sandbox/; rm -rf /", wantErr: true},
		{name: "shell injection backtick", path: "/sandbox/`whoami`", wantErr: true},
		{name: "shell injection dollar", path: "/sandbox/$HOME/file", wantErr: true},
		{name: "shell injection pipe", path: "/sandbox/file | cat /etc/passwd", wantErr: true},
		{name: "shell injection ampersand", path: "/sandbox/file && echo pwned", wantErr: true},
		{name: "space in path", path: "/sandbox/my file.txt", wantErr: true},
		{name: "newline in path", path: "/sandbox/file\nname", wantErr: true},
		{name: "single slash root", path: "/", wantErr: true},
		{name: "path with dots in filename", path: "/sandbox/.mcp.json", wantErr: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePayloadPath(tt.path)
			if (err != nil) != tt.wantErr {
				t.Errorf("validatePayloadPath(%q) error = %v, wantErr %v", tt.path, err, tt.wantErr)
			}
		})
	}
}

func TestGrpcConnBuffering(t *testing.T) {
	t.Run("reads from buffer before stream", func(t *testing.T) {
		conn := &grpcConn{buf: []byte("buffered")}
		buf := make([]byte, 4)
		n, err := conn.Read(buf)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(buf[:n]) != "buff" {
			t.Errorf("got %q, want %q", string(buf[:n]), "buff")
		}

		n, err = conn.Read(buf)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(buf[:n]) != "ered" {
			t.Errorf("got %q, want %q", string(buf[:n]), "ered")
		}
	})

	t.Run("empty buffer returns nothing", func(t *testing.T) {
		conn := &grpcConn{buf: []byte{}}
		if len(conn.buf) != 0 {
			t.Errorf("expected empty buffer")
		}
	})
}

func TestTarFilesystem(t *testing.T) {
	fs := memfs.New()

	fs.MkdirAll("/src", 0o755)
	billyutil.WriteFile(fs, "/README.md", []byte("hello"), 0o644)
	billyutil.WriteFile(fs, "/src/main.go", []byte("package main"), 0o644)

	// .git directory should be excluded
	fs.MkdirAll("/.git/objects", 0o755)
	billyutil.WriteFile(fs, "/.git/HEAD", []byte("ref: refs/heads/main"), 0o644)

	// Empty subdirectory
	fs.MkdirAll("/empty", 0o755)

	reader := tarFilesystem(context.Background(), fs)
	defer reader.Close()
	tr := tar.NewReader(reader)

	var files []string
	contents := make(map[string]string)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("tar read error: %v", err)
		}
		files = append(files, hdr.Name)
		if hdr.Typeflag == tar.TypeReg {
			data, _ := io.ReadAll(tr)
			contents[hdr.Name] = string(data)
		}
	}

	sort.Strings(files)

	// Verify .git is excluded
	for _, f := range files {
		if f == ".git" || strings.HasPrefix(f, ".git/") {
			t.Errorf("tar contains .git entry: %s", f)
		}
	}

	// Verify expected files are present
	expectFiles := map[string]bool{
		"README.md":   false,
		"src":         false,
		"src/main.go": false,
		"empty":       false,
	}
	for _, f := range files {
		if _, ok := expectFiles[f]; ok {
			expectFiles[f] = true
		}
	}
	for name, found := range expectFiles {
		if !found {
			t.Errorf("expected file %q not found in tar", name)
		}
	}

	// Verify content
	if got := contents["README.md"]; got != "hello" {
		t.Errorf("README.md content = %q, want %q", got, "hello")
	}
	if got := contents["src/main.go"]; got != "package main" {
		t.Errorf("src/main.go content = %q, want %q", got, "package main")
	}
}

func TestIsHexSHA(t *testing.T) {
	tests := []struct {
		name string
		s    string
		want bool
	}{
		{"valid lowercase sha", "aabbccddee00112233445566778899aabbccddee", true},
		{"valid mixed case sha", "AABBCCDDee00112233445566778899aabbccddee", true},
		{"too short", "aabbcc", false},
		{"too long", "aabbccddee00112233445566778899aabbccddeeff", false},
		{"non-hex char", "xabbccddee00112233445566778899aabbccddee", false},
		{"branch name", "main", false},
		{"empty", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isHexSHA(tt.s); got != tt.want {
				t.Errorf("isHexSHA(%q) = %v, want %v", tt.s, got, tt.want)
			}
		})
	}
}

func TestValidateRepoURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{"https github", "https://github.com/octocat/Hello-World.git", false},
		{"https gitlab", "https://gitlab.com/org/repo.git", false},
		{"http blocked", "http://github.com/org/repo.git", true},
		{"file scheme blocked", "file:///etc/passwd", true},
		{"git scheme blocked", "git://internal.corp/repo.git", true},
		{"ssh scheme blocked", "ssh://git@github.com/org/repo.git", true},
		{"no scheme", "github.com/org/repo.git", true},
		{"empty", "", true},
		{"internal endpoint", "https://", true},
		{"SSRF k8s API", "https://kubernetes.default.svc/api/v1", true},
		{"SSRF metadata endpoint", "https://metadata.google.internal/v1", true},
		{"SSRF localhost", "https://127.0.0.1/repo.git", true},
		{"SSRF link-local", "https://169.254.169.254/latest/meta-data", true},
		{"SSRF RFC1918 10.x", "https://10.0.0.1/repo.git", true},
		{"SSRF RFC1918 172.16.x", "https://172.16.0.1/repo.git", true},
		{"SSRF RFC1918 192.168.x", "https://192.168.1.1/repo.git", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateRepoURL(tt.url)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateRepoURL(%q) error = %v, wantErr %v", tt.url, err, tt.wantErr)
			}
		})
	}
}

func TestIsBlockedHost(t *testing.T) {
	tests := []struct {
		host    string
		blocked bool
	}{
		{"kubernetes.default", true},
		{"kubernetes.default.svc", true},
		{"metadata.google.internal", true},
		{"github.com", false},
		{"gitlab.com", false},
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			if got := isBlockedHost(tt.host); got != tt.blocked {
				t.Errorf("isBlockedHost(%q) = %v, want %v", tt.host, got, tt.blocked)
			}
		})
	}
}

func TestIsPrivateIP(t *testing.T) {
	tests := []struct {
		ip      string
		private bool
	}{
		{"10.0.0.1", true},
		{"172.16.0.1", true},
		{"192.168.1.1", true},
		{"169.254.169.254", true},
		{"127.0.0.1", true},
		{"::1", true},
		{"8.8.8.8", false},
		{"140.82.121.4", false},
	}
	for _, tt := range tests {
		t.Run(tt.ip, func(t *testing.T) {
			ip := net.ParseIP(tt.ip)
			if got := isPrivateIP(ip); got != tt.private {
				t.Errorf("isPrivateIP(%q) = %v, want %v", tt.ip, got, tt.private)
			}
		})
	}
}

func TestLimitedFS(t *testing.T) {
	t.Run("under limit", func(t *testing.T) {
		fs := newLimitedFS(memfs.New(), 1024)
		err := billyutil.WriteFile(fs, "/small.txt", []byte("hello"), 0o644)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("exceeds limit", func(t *testing.T) {
		fs := newLimitedFS(memfs.New(), 100)
		data := make([]byte, 200)
		f, err := fs.OpenFile("/big.txt", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		_, err = f.Write(data)
		f.Close()
		if err == nil {
			t.Fatal("expected error when exceeding limit, got nil")
		}
		if err.Error() != errCloneTooLarge.Error() {
			t.Errorf("got error %q, want %q", err, errCloneTooLarge)
		}
	})

	t.Run("cumulative across files", func(t *testing.T) {
		fs := newLimitedFS(memfs.New(), 100)
		f1, _ := fs.Create("/a.txt")
		f1.Write(make([]byte, 60))
		f1.Close()
		f2, _ := fs.Create("/b.txt")
		_, err := f2.Write(make([]byte, 60))
		f2.Close()
		if err == nil {
			t.Fatal("expected error when cumulative writes exceed limit, got nil")
		}
	})
}

func TestTarFilesystemCancellation(t *testing.T) {
	fs := memfs.New()
	for i := range 100 {
		billyutil.WriteFile(fs, fmt.Sprintf("/file%d.txt", i), []byte("data"), 0o644)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	reader := tarFilesystem(ctx, fs)
	defer reader.Close()

	_, err := io.ReadAll(reader)
	if err == nil {
		t.Error("expected error from cancelled context, got nil")
	}
}

func TestStagedRepoPayloadExtractCommand_ReplacesEmptyTarget(t *testing.T) {
	// Given: the sandbox image/PVC already contains an empty target directory
	// that the sandbox user can remove through its writable parent but cannot
	// write into directly.
	fs := memfs.New()
	if err := fs.MkdirAll("/.ambient/workflows", 0o755); err != nil {
		t.Fatalf("create .ambient/workflows: %v", err)
	}
	if err := fs.MkdirAll("/.claude/agents", 0o755); err != nil {
		t.Fatalf("create .claude/agents: %v", err)
	}
	if err := billyutil.WriteFile(fs, "/.ambient/workflows/code-review.json", []byte("{}"), 0o644); err != nil {
		t.Fatalf("write workflow: %v", err)
	}
	if err := billyutil.WriteFile(fs, "/.claude/agents/code-reviewer.md", []byte("review"), 0o644); err != nil {
		t.Fatalf("write agent: %v", err)
	}

	root := t.TempDir()
	target := filepath.Join(root, "session-config")
	if err := os.Mkdir(target, 0o555); err != nil {
		t.Fatalf("create unwritable target: %v", err)
	}

	reader := tarFilesystem(context.Background(), fs)
	defer reader.Close()

	// When: the repo payload extraction command receives the tar stream.
	cmd := exec.Command("sh", "-c", stagedRepoPayloadExtractCommand(target))
	cmd.Stdin = reader
	out, err := cmd.CombinedOutput()

	// Then: extraction succeeds and writes nested dot-directory content.
	if err != nil {
		t.Fatalf("extract repo payload: %v\n%s", err, out)
	}
	for _, path := range []string{
		filepath.Join(target, ".ambient", "workflows", "code-review.json"),
		filepath.Join(target, ".claude", "agents", "code-reviewer.md"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected extracted file %s: %v", path, err)
		}
	}
}
