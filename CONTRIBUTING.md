# Contributing to Agent Control Plane

Thank you for your interest in contributing to Agent Control Plane (formerly known as vTeam)! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Testing Requirements](#testing-requirements)
- [Pull Request Process](#pull-request-process)
- [Local Development Setup](#local-development-setup)
- [Troubleshooting](#troubleshooting)
- [Getting Help](#getting-help)
- [License](#license)

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for all contributors. We expect:

- Respectful and constructive communication
- Welcoming and inclusive behavior
- Focus on what is best for the community
- Showing empathy towards other community members

## Ways to Contribute

There are many ways to contribute to Agent Control Plane:

### Report Bugs

If you find a bug, please create an issue with:

- Clear, descriptive title
- Steps to reproduce the problem
- Expected vs actual behavior
- Environment details (OS, cluster version, etc.)
- Relevant logs or screenshots

### Suggest Features

We welcome feature suggestions! Please:

- Check if the feature has already been suggested
- Provide a clear use case and rationale
- Consider implementation approaches
- Be open to discussion and feedback

### Improve Documentation

Documentation improvements are always appreciated:

- Fix typos or clarify unclear sections
- Add examples or tutorials
- Document undocumented features
- Improve error messages

### Submit Code Changes

Code contributions should:

- Follow our code standards (see below)
- Include tests where applicable
- Update documentation as needed
- Pass all CI/CD checks

## Getting Started

### Prerequisites

Before contributing, ensure you have:

- Go 1.25+ (for API server and control plane development)
- Node.js 20+ and npm (for UI development)
- Python 3.12+ (for runner development)
- Podman or Docker (for building containers)
- Kind and kubectl (for local development)
- Git for version control

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/agent-control-plane.git
   cd agent-control-plane
   ```
3. Add the upstream repository:
   ```bash
   git remote add upstream https://github.com/openshift-online/agent-control-plane.git
   ```

### Install Git Hooks (Recommended)

We use the [pre-commit](https://pre-commit.com/) framework to run linters and branch protection checks automatically on every commit. Install with:

```bash
make setup-hooks
```

Or run the installation script directly:

```bash
./scripts/install-git-hooks.sh
```

**What runs on every commit:**

- **File hygiene** - trailing whitespace, EOF fixer, YAML validation, large file check, merge conflict markers, private key detection
- **Python** - `ruff format` + `ruff check --fix` (runners and scripts)
- **Go** - `gofmt`, `go vet`, `golangci-lint` (API server, control plane, CLI)
- **Branch protection** - blocks commits to `main`/`master`/`production`

**What runs on push:**

- **Push protection** - blocks pushes to `main`/`master`/`production`

**Run all hooks manually:**

```bash
make lint
# or: pre-commit run --all-files
```

If you need to override the hooks (e.g., for hotfixes):

```bash
git commit --no-verify -m "hotfix: critical fix"
git push --no-verify origin main
```

See [scripts/git-hooks/README.md](scripts/git-hooks/README.md) for more details.

## Development Workflow

### 1. Create a Feature Branch

Always work on a feature branch, not `main`:

```bash
git checkout main
git pull upstream main
git checkout -b feature/your-feature-name
```

Branch naming conventions:

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test improvements

### 2. Make Your Changes

- Follow the existing code patterns and style
- Write clear, descriptive commit messages
- Keep commits focused and atomic
- Test your changes locally

### 3. Commit Your Changes

Use conventional commit messages:

```bash
git commit -m "feat: add multi-repo session support"
git commit -m "fix: resolve PVC mounting issue in kind cluster"
git commit -m "docs: update local development setup instructions"
git commit -m "test: add integration tests for operator"
```

Commit message prefixes:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

### 4. Keep Your Branch Updated

Regularly sync with upstream:

```bash
git fetch upstream
git rebase upstream/main
```

### 5. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a Pull Request on GitHub.

## Code Standards

### Go Code (API Server & Control Plane)

**Formatting:**
```bash
# Auto-format your code
gofmt -w components/ambient-api-server components/ambient-control-plane
```

**Quality Checks:**
```bash
# API Server
cd components/ambient-api-server
gofmt -l .                    # Check formatting (should output nothing)
go vet ./...                  # Detect suspicious constructs
golangci-lint run            # Run comprehensive linting

# Control Plane
cd components/ambient-control-plane
gofmt -l .
go vet ./...
golangci-lint run
```

**Install golangci-lint:**
```bash
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
```

**Best Practices:**

- Use explicit error handling, never `panic()` in production code
- Always use user-scoped Kubernetes clients for API operations
- Implement proper RBAC checks before resource access
- Never log sensitive data (tokens, API keys)
- Use `unstructured.Nested*` helpers for type-safe CR access
- Set OwnerReferences on child resources for automatic cleanup

See [CLAUDE.md](CLAUDE.md) for comprehensive backend/operator development standards.

### Frontend Code (NextJS)

```bash
cd components/ambient-ui
npm run lint                  # ESLint checks
npm run build                 # Ensure builds without errors/warnings
```

**Best Practices:**

- Zero `any` types (use proper TypeScript types)
- Use Shadcn UI components only (no custom UI from scratch)
- Use React Query for ALL data operations (no manual `fetch()`)
- Use `type` over `interface`
- Colocate single-use components with their pages
- All buttons must show loading states
- All lists must have empty states
- All nested pages must have breadcrumbs

### Python Code (Runners)

```bash
cd components/runners/ambient-runner

# Format code
ruff format .

# Lint (with auto-fix)
ruff check --fix .
```

**Standards:**

- Use `ruff format` for formatting
- Use `ruff check` for linting
- Follow PEP 8 conventions
- Add type hints where appropriate

## Testing Requirements

### API Server Tests

```bash
cd components/ambient-api-server
make test
```

### Control Plane Tests

```bash
cd components/ambient-control-plane
go test ./... -v
```

### UI Tests

```bash
cd components/ambient-ui
npx vitest run
```

**Testing Guidelines:**

- Add tests for new features
- Ensure tests pass locally before pushing
- Aim for meaningful test coverage
- Write clear test descriptions
- Use table-driven tests in Go

## Pull Request Process

### Before Submitting

1. **Run all quality checks** for the components you modified
2. **Run tests** and ensure they pass
3. **Update documentation** if you changed functionality
4. **Rebase on latest main** to avoid merge conflicts
5. **Test locally** with Kind if possible

### PR Description

Your PR should include:

- **Clear title** describing the change
- **Description** of what changed and why
- **Related issues** (use "Fixes #123" or "Relates to #123")
- **Testing performed** - how you verified the changes
- **Screenshots** (if UI changes)
- **Breaking changes** (if any)

### Review Process

- All PRs require at least one approval
- GitHub Actions will automatically run:
  - Go linting checks (gofmt, go vet, golangci-lint)
  - Component builds
  - Tests
- Address review feedback promptly
- Keep discussions focused and professional
- Be open to suggestions and alternative approaches

### After Approval

- Squash commits will happen automatically on merge
- Your PR will be merged to `main`
- Delete your feature branch after merge

## Local Development Setup

The recommended way to develop and test Agent Control Plane locally is using **Kind (Kubernetes in Docker)**. This provides a lightweight Kubernetes environment that matches our CI/CD setup.

### Installing Kind and Prerequisites

#### macOS

```bash
# Install using Homebrew
brew install kind kubectl docker
```

#### Linux

```bash
# Install kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Install Kind
curl -Lo ./kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64
chmod +x ./kind
sudo mv ./kind /usr/local/bin/kind

# Install Docker
# Follow: https://docs.docker.com/engine/install/
```

### Quick Start

Once Kind and prerequisites are installed, you can start the complete development environment with a single command:

#### First-Time Setup

```bash
make kind-up
```

This command will:
- Create Kind cluster (~30 seconds)
- Deploy all components (API server, control plane, UI)
- Deploy Keycloak with a pre-configured dev realm
- Set up port forwarding
- Load container images

The setup takes ~2 minutes on first run.

#### Access the Application

```bash
make kind-port-forward  # In another terminal
# Open the frontend URL shown in the output
```

You'll be redirected to Keycloak for login. Use `developer` / `developer`.

#### Stopping and Restarting

Stop and delete the Kind cluster:

```bash
make kind-down
```

Restart:

```bash
make kind-up
```

### Additional Development Commands

**Check status:**
```bash
kubectl get pods -n ambient-code
kubectl get svc -n ambient-code
```

**View logs:**
```bash
kubectl logs -n ambient-code deployment/ambient-api-server -f
kubectl logs -n ambient-code deployment/ambient-ui -f
kubectl logs -n ambient-code deployment/ambient-control-plane -f
```

**Cleanup:**
```bash
make kind-down         # Delete Kind cluster
```

**Run tests:**
```bash
make test-e2e-local    # Run E2E tests with Kind
```

## Troubleshooting

### Kind Cluster Issues

#### Cluster Won't Start

```bash
# Check Docker is running
docker ps

# Delete and recreate cluster
make kind-down
make kind-up
```

#### Pods Not Starting

```bash
# Check pod status
kubectl get pods -n ambient-code

# View pod details
kubectl describe pod <pod-name> -n ambient-code

# Check logs
kubectl logs <pod-name> -n ambient-code
```

#### Port Forwarding Issues

```bash
# Check if port 8080 is in use
lsof -i :8080

# Restart port forwarding
make kind-down
make kind-up
```

#### Complete Reset

If Kind cluster is broken:

```bash
# Delete cluster
kind delete cluster --name ambient-code

# Recreate
make kind-up
```

### Application Issues

**Pods not starting:**

```bash
kubectl get pods -n ambient-code
kubectl describe pod <pod-name> -n ambient-code
kubectl logs <pod-name> -n ambient-code
```

**Image issues:**

```bash
# Check if images are loaded
docker exec -it ambient-code-control-plane crictl images | grep ambient
```

**Service not accessible:**

```bash
# Check services
kubectl get services -n ambient-code

# Check ingress
kubectl get ingress -n ambient-code

# Test directly
kubectl port-forward -n ambient-code svc/ambient-ui-service 3000:3000
```

**Networking issues:**

```bash
# Check ingress controller
kubectl get pods -n ingress-nginx

# Restart port forwarding
make kind-down
make kind-up
```

## Getting Help

If you're stuck or have questions:

1. **Check existing documentation:**
   - [CLAUDE.md](CLAUDE.md) - Comprehensive development standards
   - [README.md](README.md) - Project overview and quick start
   - [BOOKMARKS.md](BOOKMARKS.md) - Developer bookmarks and reference index
   - [docs/internal/](docs/internal/) - Architecture, design, and developer docs

2. **Search existing issues:**
   - Check if your issue has already been reported
   - Look for solutions in closed issues

3. **Create a new issue:**
   - Provide clear description and reproduction steps
   - Include relevant logs and error messages
   - Tag with appropriate labels

## License

By contributing to Agent Control Plane, you agree that your contributions will be licensed under the same license as the project (MIT License).
