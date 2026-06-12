---
title: "Credentials"
---

ACP integrations are credential records plus runtime wiring. The API stores credentials, role bindings control token access, and the control plane decides how to expose those credentials to a session.

## Credential records

Credential endpoints exist globally and under projects:

```text
GET  /api/ambient/v1/credentials
POST /api/ambient/v1/credentials
GET  /api/ambient/v1/projects/{id}/credentials
POST /api/ambient/v1/projects/{id}/credentials
GET  /api/ambient/v1/projects/{id}/credentials/{cred_id}/token
```

A credential has:

- `name`
- `provider`
- `token`
- `url`
- `email`
- `labels`
- `annotations`

The OpenAPI provider enum includes `github`, `gitlab`, `jira`, `google`, `vertex`, and `kubeconfig`. The CLI create command currently advertises `github`, `gitlab`, `jira`, `google`, and `kubeconfig`.

## Token access

The API does not return credential tokens in normal credential responses. Token reads go through `/token` endpoints and require authorization.

Use role bindings to grant access at the right scope. The control plane may also create internal `credential:token-reader` bindings for session ServiceAccounts when sidecar-based token exchange is enabled.

## Runtime injection

When a session starts, credential resolution is layered:

1. global credentials.
2. project credentials.
3. agent credentials.

For each provider, a more specific layer can override a less specific one. Management-only `credential:owner` bindings are not treated as runtime injection bindings.

If credential sidecars are enabled, the control plane adds provider sidecars for supported providers and passes sidecar URLs to the runner. If sidecars are not enabled, the runner can fall back to `CREDENTIAL_IDS` and fetch tokens from the API.

## MCP tools

The Claude runner can use MCP servers for platform tools and credential-backed providers. The control plane can inject an `ambient-mcp` sidecar when `MCP_IMAGE`, the control-plane token URL, and public key are configured. Credential sidecars can expose GitHub, Jira, kubeconfig, and Google tools when their images and credentials are configured.

## OAuth status

The current session plugin contains an OAuth URL handler that returns `501 not implemented`. Do not rely on OAuth setup flows unless your deployment has added them outside this codebase.

## CLI examples

```bash
acpctl credential create --name github-main --provider github --token "$GITHUB_TOKEN"
acpctl credential create --name jira --provider jira --url https://example.atlassian.net --email dev@example.com --token "$JIRA_API_TOKEN"
acpctl credential list --provider github
acpctl credential bind github-main --project my-project
```
