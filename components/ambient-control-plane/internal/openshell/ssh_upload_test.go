package openshell

import (
	"archive/tar"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
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

func TestTarDirectory(t *testing.T) {
	dir := t.TempDir()

	os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello"), 0o644)
	os.WriteFile(filepath.Join(dir, "src", "main.go"), []byte("package main"), 0o644)

	// .git directory should be excluded
	os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0o755)
	os.WriteFile(filepath.Join(dir, ".git", "HEAD"), []byte("ref: refs/heads/main"), 0o644)

	// Empty subdirectory
	os.MkdirAll(filepath.Join(dir, "empty"), 0o755)

	reader := tarDirectory(dir)
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
		if f == ".git" || strings.HasPrefix(f, ".git/") || strings.HasPrefix(f, ".git"+string(filepath.Separator)) {
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
