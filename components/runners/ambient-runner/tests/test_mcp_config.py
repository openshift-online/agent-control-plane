"""Tests for MCP config loading from baked-in and payload .mcp.json files."""

import json
from pathlib import Path


from ambient_runner.platform.config import load_mcp_config
from ambient_runner.platform.context import RunnerContext


def _make_context(env: dict[str, str] | None = None) -> RunnerContext:
    """Create a minimal RunnerContext with optional env overrides."""
    return RunnerContext(
        session_id="test-session",
        workspace_path="/workspace",
        environment=env or {},
    )


class TestLoadMcpConfig:
    """Tests for load_mcp_config with baked-in and payload .mcp.json merge."""

    def test_loads_from_default_file(self, tmp_path: Path):
        """Should load servers from baked-in .mcp.json file."""
        mcp_file = tmp_path / ".mcp.json"
        mcp_file.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "context7": {
                            "type": "http",
                            "url": "https://mcp.context7.com/mcp",
                        },
                        "webfetch": {"command": "uvx", "args": ["mcp-server-fetch"]},
                    }
                }
            )
        )
        ctx = _make_context({"MCP_CONFIG_FILE": str(mcp_file)})
        result = load_mcp_config(ctx, str(tmp_path))
        assert result is not None
        assert "context7" in result
        assert "webfetch" in result
        assert result["context7"]["url"] == "https://mcp.context7.com/mcp"

    def test_merges_payload_mcp_json(self, tmp_path: Path):
        """Payload .mcp.json (platform-controlled path) should merge with baked-in."""
        baked_dir = tmp_path / "baked"
        baked_dir.mkdir()
        baked_file = baked_dir / ".mcp.json"
        baked_file.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "context7": {
                            "type": "http",
                            "url": "https://mcp.context7.com/mcp",
                        },
                    }
                }
            )
        )

        payload_file = tmp_path / "payload" / ".mcp.json"
        payload_file.parent.mkdir()
        payload_file.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "mcp-atlassian": {
                            "type": "stdio",
                            "command": "mcp-atlassian",
                            "env": {
                                "JIRA_URL": "https://example.atlassian.net",
                                "JIRA_USERNAME": "${JIRA_USERNAME}",
                            },
                        },
                    }
                }
            )
        )

        ctx = _make_context(
            {
                "MCP_CONFIG_FILE": str(baked_file),
                "PAYLOAD_MCP_CONFIG_FILE": str(payload_file),
            }
        )
        result = load_mcp_config(ctx, "/workspace/repos/user-repo")
        assert result is not None
        assert "context7" in result
        assert "mcp-atlassian" in result

    def test_payload_overrides_baked_in(self, tmp_path: Path):
        """Payload config should override baked-in for same server name."""
        baked_dir = tmp_path / "baked"
        baked_dir.mkdir()
        baked_file = baked_dir / ".mcp.json"
        baked_file.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "shared": {"type": "http", "url": "https://baked.com"},
                    }
                }
            )
        )

        payload_file = tmp_path / "payload.mcp.json"
        payload_file.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "shared": {"type": "http", "url": "https://payload.com"},
                    }
                }
            )
        )

        ctx = _make_context(
            {
                "MCP_CONFIG_FILE": str(baked_file),
                "PAYLOAD_MCP_CONFIG_FILE": str(payload_file),
            }
        )
        result = load_mcp_config(ctx, "/workspace/repos/user-repo")
        assert result is not None
        assert result["shared"]["url"] == "https://payload.com"

    def test_ignores_cwd_mcp_json(self, tmp_path: Path):
        """Must NOT load .mcp.json from cwd (user-controlled workspace)."""
        baked_dir = tmp_path / "baked"
        baked_dir.mkdir()
        baked_file = baked_dir / ".mcp.json"
        baked_file.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "safe": {"type": "http", "url": "https://safe.com"},
                    }
                }
            )
        )

        cwd_dir = tmp_path / "workspace"
        cwd_dir.mkdir()
        (cwd_dir / ".mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "malicious": {"command": "evil-binary", "args": ["--pwn"]},
                    }
                }
            )
        )

        ctx = _make_context({"MCP_CONFIG_FILE": str(baked_file)})
        result = load_mcp_config(ctx, str(cwd_dir))
        assert result is not None
        assert "safe" in result
        assert "malicious" not in result

    def test_env_vars_not_expanded(self, tmp_path: Path):
        """Env var patterns like ${VAR} must be passed through as-is."""
        mcp_file = tmp_path / ".mcp.json"
        mcp_file.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "test-server": {
                            "command": "test-cmd",
                            "env": {
                                "TOKEN": "${MY_SECRET_TOKEN}",
                                "WITH_DEFAULT": "${MISSING:-fallback}",
                            },
                        }
                    }
                }
            )
        )
        ctx = _make_context({"MCP_CONFIG_FILE": str(mcp_file)})
        result = load_mcp_config(ctx, str(tmp_path))
        assert result is not None
        assert result["test-server"]["env"]["TOKEN"] == "${MY_SECRET_TOKEN}"
        assert result["test-server"]["env"]["WITH_DEFAULT"] == "${MISSING:-fallback}"

    def test_returns_none_when_no_servers(self, tmp_path: Path):
        """Should return None when no servers are configured."""
        mcp_file = tmp_path / ".mcp.json"
        mcp_file.write_text(json.dumps({"mcpServers": {}}))
        ctx = _make_context({"MCP_CONFIG_FILE": str(mcp_file)})
        result = load_mcp_config(ctx, str(tmp_path))
        assert result is None

    def test_returns_none_when_no_file(self, tmp_path: Path):
        """Should return None when no .mcp.json file exists."""
        ctx = _make_context({"MCP_CONFIG_FILE": str(tmp_path / "nonexistent.json")})
        result = load_mcp_config(ctx, str(tmp_path))
        assert result is None

    def test_handles_invalid_payload_json(self, tmp_path: Path):
        """Should gracefully handle malformed payload .mcp.json."""
        baked_dir = tmp_path / "baked"
        baked_dir.mkdir()
        baked_file = baked_dir / ".mcp.json"
        baked_file.write_text(
            json.dumps(
                {"mcpServers": {"s1": {"type": "http", "url": "https://s1.com"}}}
            )
        )

        payload_file = tmp_path / "bad-payload.mcp.json"
        payload_file.write_text("not-json")

        ctx = _make_context(
            {
                "MCP_CONFIG_FILE": str(baked_file),
                "PAYLOAD_MCP_CONFIG_FILE": str(payload_file),
            }
        )
        result = load_mcp_config(ctx, "/workspace/repos/user-repo")
        assert result is not None
        assert "s1" in result
