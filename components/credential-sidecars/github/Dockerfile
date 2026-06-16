FROM registry.access.redhat.com/ubi9/go-toolset:1.24 AS entrypoint-builder

USER 0
WORKDIR /build
COPY credential-sidecars/entrypoint/ ./entrypoint/
COPY ambient-mcp/ ./ambient-mcp/

WORKDIR /build/entrypoint
RUN go mod edit -replace github.com/ambient-code/platform/components/ambient-mcp=../ambient-mcp && \
    go mod tidy && \
    CGO_ENABLED=0 go build -o /credential-entrypoint .

# Build github-mcp-server from source at a pinned tag.
# Go 1.25+ required; UBI go-toolset only ships 1.21, so we bootstrap from the
# official tarball with SHA-256 verification.
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest AS mcp-builder

ARG GITHUB_MCP_VERSION=v1.3.0
ARG GO_VERSION=1.25.11
ARG GO_SHA256=34f14304e856893f4ba30c2cacfe93906e9de7915c5f6aaaf3a81cdccd7ba30b

USER 0
RUN microdnf install -y git tar gzip && microdnf clean all

RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz && \
    echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c - && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    rm /tmp/go.tar.gz

ENV PATH="/usr/local/go/bin:${PATH}"

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

ARG IMAGE_EXPIRY=
LABEL quay.expires-after=${IMAGE_EXPIRY}
