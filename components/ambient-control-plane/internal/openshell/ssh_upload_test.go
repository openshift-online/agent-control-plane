package openshell

import (
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
