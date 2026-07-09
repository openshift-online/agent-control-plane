FROM registry.access.redhat.com/ubi9/go-toolset:1.25 AS entrypoint-builder

USER 0
WORKDIR /build
COPY components/credential-sidecars/entrypoint/ ./entrypoint/
COPY components/ambient-mcp/ ./ambient-mcp/

WORKDIR /build/entrypoint
RUN go mod edit -replace github.com/ambient-code/platform/components/ambient-mcp=../ambient-mcp && \
    go mod tidy && \
    CGO_ENABLED=0 go build -o /credential-entrypoint .

# Build github-mcp-server from source at a pinned tag.
FROM registry.access.redhat.com/ubi9/go-toolset:1.25 AS mcp-builder

ARG GITHUB_MCP_VERSION=v1.3.0

USER 0

WORKDIR /build
RUN git clone --depth 1 --branch "${GITHUB_MCP_VERSION}" \
      https://github.com/github/github-mcp-server.git . && \
    CGO_ENABLED=0 go build \
      -ldflags="-s -w -X main.version=${GITHUB_MCP_VERSION}" \
      -o /github-mcp-server ./cmd/github-mcp-server

FROM registry.access.redhat.com/ubi9/python-312:latest

USER 0
RUN pip install --no-cache-dir mcp-proxy && \
    chown -R 1001:0 /opt/app-root

COPY --from=mcp-builder /github-mcp-server /opt/app-root/bin/github-mcp-server
COPY --from=entrypoint-builder /credential-entrypoint /opt/app-root/bin/credential-entrypoint

ENV CREDENTIAL_PROVIDER=github

USER 1001

EXPOSE 8091

ENTRYPOINT ["credential-entrypoint", "mcp-proxy", "--pass-environment", "--port", "8091", "--"]
CMD ["github-mcp-server", "stdio"]
