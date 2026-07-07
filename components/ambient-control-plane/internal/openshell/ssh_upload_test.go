package openshell

import (
	"archive/tar"
	"io"
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

	reader := tarFilesystem(fs)
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
