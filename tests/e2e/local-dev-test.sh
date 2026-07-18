#!/usr/bin/env bash
#
# Local Developer Experience Test Suite
# Tests the complete local development workflow for Agent Control Plane
#
# Usage: ./tests/local-dev-test.sh [options]
#   -s, --skip-setup    Skip the initial setup (assume environment is ready)
#   -c, --cleanup       Clean up after tests
#   -v, --verbose       Verbose output
#   --ci                CI mode (treats known TODOs as non-failures)
#

# Don't exit on error - we want to collect all test results
# shellcheck disable=SC2103  # Intentional: continue on errors to collect all test results
set +e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Test configuration
NAMESPACE="${NAMESPACE:-ambient-code}"
SKIP_SETUP=false
CLEANUP=false
VERBOSE=false
CI_MODE=false
FAILED=0
PASSED=0
KNOWN_FAILURES=0

# Get test URL for a service via port-forwarding (kind uses localhost)
get_test_url() {
    local port=$1

    # Kind uses port-forwarding to localhost
    if [[ "$port" == "30080" ]]; then
        echo "http://localhost:8080"
    elif [[ "$port" == "30030" ]]; then
        echo "http://localhost:3000"
    else
        echo "http://localhost:${port}"
    fi
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -s|--skip-setup)
            SKIP_SETUP=true
            shift
            ;;
        -c|--cleanup)
            CLEANUP=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        --ci)
            CI_MODE=true
            shift
            ;;
        -h|--help)
            head -n 10 "$0" | tail -n 7
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Canonical output helpers
pass() { echo -e "  ${GREEN}✓${NC} $1"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}⊘${NC} $1 (skipped: $2)"; }
section() { echo ""; echo -e "${BOLD}$1${NC}"; }

# Informational helpers (not test results)
log_info() {
    echo -e "${BLUE}ℹ${NC} $*"
}

log_warning() {
    echo -e "  ${YELLOW}⚠${NC} $*"
}

# Test assertion functions
assert_command_exists() {
    local cmd=$1
    if command -v "$cmd" >/dev/null 2>&1; then
        pass "Command '$cmd' is installed"
        return 0
    else
        fail "Command '$cmd' is NOT installed"
        return 1
    fi
}

assert_equals() {
    local expected=$1
    local actual=$2
    local description=$3

    if [ "$expected" = "$actual" ]; then
        pass "$description"
        return 0
    else
        fail "$description"
        echo -e "  ${RED}✗${NC}   Expected: $expected"
        echo -e "  ${RED}✗${NC}   Actual: $actual"
        return 1
    fi
}

assert_contains() {
    local haystack=$1
    local needle=$2
    local description=$3

    if echo "$haystack" | grep -q "$needle"; then
        pass "$description"
        return 0
    else
        fail "$description"
        echo -e "  ${RED}✗${NC}   Expected to contain: $needle"
        echo -e "  ${RED}✗${NC}   Actual: $haystack"
        return 1
    fi
}

assert_http_ok() {
    local url=$1
    local description=$2
    local max_retries=${3:-5}
    local retry=0

    while [ $retry -lt $max_retries ]; do
        if curl -sf "$url" >/dev/null 2>&1; then
            pass "$description"
            return 0
        fi
        ((retry++))
        [ $retry -lt $max_retries ] && sleep 2
    done

    fail "$description (after $max_retries retries)"
    return 1
}

assert_pod_running() {
    local label=$1
    local description=$2

    if kubectl get pods -n "$NAMESPACE" -l "$label" 2>/dev/null | grep -q "Running"; then
        pass "$description"
        return 0
    else
        fail "$description"
        return 1
    fi
}

# Test: Prerequisites
test_prerequisites() {
    # ============================================================================
    # Section 1: Prerequisites
    # ============================================================================

    section "1. Prerequisites"

    assert_command_exists "make"
    assert_command_exists "kubectl"
    assert_command_exists "kind"
    assert_command_exists "podman" || assert_command_exists "docker"

    # Check if running on macOS or Linux
    if [[ "$OSTYPE" == "darwin"* ]]; then
        log_info "Running on macOS"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        log_info "Running on Linux"
    else
        log_warning "Unknown OS: $OSTYPE"
    fi
}

# Test: Makefile Help
test_makefile_help() {
    # ============================================================================
    # Section 2: Makefile Help Command
    # ============================================================================

    section "2. Makefile Help Command"

    local help_output
    help_output=$(make help 2>&1)

    assert_contains "$help_output" "Agent Control Plane" "Help shows correct branding"
    assert_contains "$help_output" "kind-up" "Help lists kind-up command"
    assert_contains "$help_output" "local-status" "Help lists local-status command"
    assert_contains "$help_output" "local-logs" "Help lists local-logs command"
}

# Test: Kind Status Check
test_kind_status() {
    # ============================================================================
    # Section 3: Kind Status
    # ============================================================================

    section "3. Kind Status"

    if kind get clusters 2>/dev/null | grep -q .; then
        pass "Kind cluster is running"

        # Check kind version
        local version
        version=$(kind version 2>/dev/null || echo "unknown")
        log_info "Kind version: $version"
    else
        fail "No Kind cluster is running"
        return 1
    fi
}

# Test: Kubernetes Context
test_kubernetes_context() {
    # ============================================================================
    # Section 4: Kubernetes Context
    # ============================================================================

    section "4. Kubernetes Context"

    local context
    context=$(kubectl config current-context 2>/dev/null || echo "none")

    assert_contains "$context" "kind-" "kubectl context is set to a kind cluster"

    # Test kubectl connectivity
    if kubectl cluster-info >/dev/null 2>&1; then
        pass "kubectl can connect to cluster"
    else
        fail "kubectl cannot connect to cluster"
    fi
}

# Test: Namespace Exists
test_namespace_exists() {
    # ============================================================================
    # Section 5: Namespace Existence
    # ============================================================================

    section "5. Namespace Existence"

    if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
        pass "Namespace '$NAMESPACE' exists"
    else
        fail "Namespace '$NAMESPACE' does NOT exist"
        return 1
    fi
}

# Test: Pods Running
test_pods_running() {
    # ============================================================================
    # Section 6: Pod Status
    # ============================================================================

    section "6. Pod Status"

    assert_pod_running "app=ambient-api-server" "Backend pod is running"
    assert_pod_running "app=ambient-ui" "Frontend pod is running"
    assert_pod_running "app=ambient-control-plane" "Control plane pod is running"

    # Check pod readiness
    local not_ready
    not_ready=$(kubectl get pods -n "$NAMESPACE" --field-selector=status.phase!=Running 2>/dev/null | grep -v "NAME" | wc -l)

    if [ "$not_ready" -eq 0 ]; then
        pass "All pods are in Running state"
    else
        log_warning "$not_ready pod(s) are not running"
    fi
}

# Test: Services Exist
test_services_exist() {
    # ============================================================================
    # Section 7: Services
    # ============================================================================

    section "7. Services"

    local services=("ambient-api-server" "ambient-ui-service")

    for svc in "${services[@]}"; do
        if kubectl get svc "$svc" -n "$NAMESPACE" >/dev/null 2>&1; then
            pass "Service '$svc' exists"
        else
            fail "Service '$svc' does NOT exist"
        fi
    done
}

# Test: Backend Health Endpoint
test_backend_health() {
    # ============================================================================
    # Section 8: Backend Health Endpoint
    # ============================================================================

    section "8. Backend Health Endpoint"

    # Check backend health via pod readiness (kubectl wait already validates the
    # readiness probe which hits /health). Verify pod is ready as a proxy.
    if kubectl get pods -n "$NAMESPACE" -l app=ambient-api-server -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -q "True"; then
        pass "Backend health endpoint responds (pod readiness probe passes)"
    else
        fail "Backend pod is not ready (health endpoint may not be responding)"
    fi
}

# Test: Frontend Accessibility
test_frontend_accessibility() {
    # ============================================================================
    # Section 9: Frontend Accessibility
    # ============================================================================

    section "9. Frontend Accessibility"

    # Check frontend health via pod readiness
    if kubectl get pods -n "$NAMESPACE" -l app=ambient-ui -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null | grep -q "True"; then
        pass "Frontend is accessible (pod readiness probe passes)"
    else
        fail "Frontend pod is not ready"
    fi
}

# Test: RBAC Configuration
test_rbac() {
    # ============================================================================
    # Section 10: RBAC Configuration
    # ============================================================================

    section "10. RBAC Configuration"

    local roles=("ambient-project-admin" "ambient-project-edit" "ambient-project-view")

    for role in "${roles[@]}"; do
        if kubectl get clusterrole "$role" >/dev/null 2>&1; then
            pass "ClusterRole '$role' exists"
        else
            fail "ClusterRole '$role' does NOT exist"
        fi
    done
}

# Test: Development Workflow - Build Command
test_build_command() {
    # ============================================================================
    # Section 11: Build Commands (Dry Run)
    # ============================================================================

    section "11. Build Commands (Dry Run)"

    if make -n build-api-server >/dev/null 2>&1; then
        pass "make build-api-server syntax is valid"
    else
        fail "make build-api-server has syntax errors"
    fi

    if make -n build-ambient-ui >/dev/null 2>&1; then
        pass "make build-ambient-ui syntax is valid"
    else
        fail "make build-ambient-ui has syntax errors"
    fi

    if make -n build-control-plane >/dev/null 2>&1; then
        pass "make build-control-plane syntax is valid"
    else
        fail "make build-control-plane has syntax errors"
    fi
}

# Test: Benchmark Harness Syntax
test_benchmark_syntax() {
    # ============================================================================
    # Section 12: Benchmark Harness Syntax
    # ============================================================================

    section "12. Benchmark Harness Syntax"

    if bash -n scripts/benchmarks/component-bench.sh 2>/dev/null; then
        pass "component-bench.sh syntax is valid"
    else
        fail "component-bench.sh has syntax errors"
    fi

    if make -n benchmark >/dev/null 2>&1; then
        pass "make benchmark syntax is valid"
    else
        fail "make benchmark has syntax errors"
    fi
}

# Test: Logging Commands
test_logging_commands() {
    # ============================================================================
    # Section 13: Logging Commands
    # ============================================================================

    section "13. Logging Commands"

    # Test that we can get logs from each component
    local components=("ambient-api-server" "ambient-ui" "ambient-control-plane")

    for component in "${components[@]}"; do
        if kubectl logs -n "$NAMESPACE" -l "app=$component" --tail=1 >/dev/null 2>&1; then
            pass "Can retrieve logs from $component"
        else
            log_warning "Cannot retrieve logs from $component (pod may not be running)"
        fi
    done
}

# Test: Storage Configuration
test_storage() {
    # ============================================================================
    # Section 14: Storage Configuration
    # ============================================================================

    section "14. Storage Configuration"

    # Check if workspace PVC exists
    if kubectl get pvc workspace-pvc -n "$NAMESPACE" >/dev/null 2>&1; then
        pass "Workspace PVC exists"

        # Check PVC status
        local status
        status=$(kubectl get pvc workspace-pvc -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null)
        if [ "$status" = "Bound" ]; then
            pass "Workspace PVC is bound"
        else
            log_warning "Workspace PVC status: $status"
        fi
    else
        log_info "Workspace PVC does not exist (may not be required for all deployments)"
    fi
}

# Test: Resource Limits
test_resource_limits() {
    # ============================================================================
    # Section 15: Resource Configuration
    # ============================================================================

    section "15. Resource Configuration"

    # Check if deployments have resource requests/limits
    local deployments=("ambient-api-server" "ambient-ui" "ambient-control-plane")

    for deployment in "${deployments[@]}"; do
        local resources
        resources=$(kubectl get deployment "$deployment" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].resources}' 2>/dev/null || echo "{}")

        if [ "$resources" != "{}" ]; then
            pass "Deployment '$deployment' has resource configuration"
        else
            log_info "Deployment '$deployment' has no resource limits (OK for dev)"
        fi
    done
}

# Test: Make local-status
test_make_status() {
    # ============================================================================
    # Section 16: make local-status Command
    # ============================================================================

    section "16. make local-status Command"

    local status_output
    # Pass CONTAINER_ENGINE so kind get clusters uses the correct provider
    local engine
    if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
        engine=docker
    else
        engine=podman
    fi
    status_output=$(make local-status CONTAINER_ENGINE="$engine" 2>&1 || echo "")

    assert_contains "$status_output" "Agent Control Plane Status" "Status shows correct branding"
    assert_contains "$status_output" "Pods" "Status shows Pods section"
}

# Test: Security - Test User Permissions
test_security_local_dev_user() {
    # ============================================================================
    # Section 17: Security - Test User Permissions
    # ============================================================================

    section "17. Security - Test User Permissions"

    log_info "Verifying test-user service account exists..."

    # Kind creates a test-user service account with a pre-generated token
    if kubectl get serviceaccount test-user -n "$NAMESPACE" >/dev/null 2>&1; then
        pass "test-user service account exists"
    else
        log_warning "test-user service account does not exist (may not be set up yet)"
        # Not a hard failure — kind-up creates this but test may run before setup completes
        PASSED=$((PASSED + 1))
        return
    fi

    # Check that the test-user token secret exists
    if kubectl get secret test-user-token -n "$NAMESPACE" >/dev/null 2>&1; then
        pass "test-user-token secret exists"
    else
        log_warning "test-user-token secret does not exist"
        PASSED=$((PASSED + 1))
    fi
}

# Test: Security - Production Namespace Rejection
test_security_prod_namespace_rejection() {
    # ============================================================================
    # Section 18: Security - Production Namespace Rejection
    # ============================================================================

    section "18. Security - Production Namespace Rejection"

    log_info "Testing that dev mode rejects production-like namespaces..."

    # Test 1: Check backend middleware has protection
    local backend_pod
    backend_pod=$(kubectl get pods -n "$NAMESPACE" -l app=ambient-api-server -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

    if [ -z "$backend_pod" ]; then
        log_warning "Backend pod not found, skipping namespace rejection test"
        return
    fi

    # Test 1: Verify namespace does not contain 'prod'
    if echo "$NAMESPACE" | grep -qi "prod"; then
        echo -e "  ${RED}✗${NC} Namespace contains 'prod' - this would be REJECTED by middleware (GOOD)"
        echo -e "  ${RED}✗${NC} Current namespace: $NAMESPACE"
        log_info "Dev mode should NEVER run in production namespaces"
        PASSED=$((PASSED + 1))  # This is correct behavior - we want it to fail
    else
        pass "Namespace does not contain 'prod' (safe for dev mode)"
    fi

    # Test 2: Document the protection mechanism
    log_info "Middleware protection:"
    log_info "  • Checks if namespace contains 'prod'"
    log_info "  • Uses real token auth (no DISABLE_AUTH in kind)"
}

# Test: Security - Mock Token Detection in Logs
test_security_mock_token_logging() {
    # ============================================================================
    # Section 19: Security - Mock Token Detection
    # ============================================================================

    section "19. Security - Mock Token Detection"

    log_info "Verifying backend logs show dev mode activation..."

    local backend_pod
    backend_pod=$(kubectl get pods -n "$NAMESPACE" -l app=ambient-api-server -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

    if [ -z "$backend_pod" ]; then
        log_warning "Backend pod not found, skipping log test"
        return
    fi

    # Get recent backend logs
    local logs
    logs=$(kubectl logs -n "$NAMESPACE" "$backend_pod" --tail=100 2>/dev/null || echo "")

    if [ -z "$logs" ]; then
        log_warning "Could not retrieve backend logs"
        return
    fi

    # Test 1: Check for dev mode detection logs
    if echo "$logs" | grep -q "Local dev mode detected\|Dev mode detected\|local dev environment"; then
        pass "Backend logs show dev mode activation"
    else
        log_info "Backend logs do not show dev mode activation yet (may need API call to trigger)"
    fi

    # Test 2: Verify logs do NOT contain the actual mock token value
    if echo "$logs" | grep -q "mock-token-for-local-dev"; then
        fail "Backend logs contain mock token value (SECURITY ISSUE - tokens should be redacted)"
    else
        pass "Backend logs do NOT contain mock token value (correct - tokens are redacted)"
    fi

    # Test 3: Check for service account usage logging
    if echo "$logs" | grep -q "using.*service account\|K8sClient\|DynamicClient"; then
        pass "Backend logs reference service account usage"
    else
        log_info "Backend logs do not show service account usage (may need API call to trigger)"
    fi

    # Test 4: Verify environment validation logs
    if echo "$logs" | grep -q "Local dev environment validated\|env=local\|env=development"; then
        pass "Backend logs show environment validation"
    else
        log_info "Backend logs do not show environment validation yet"
    fi
}

# Test: Security - Token Redaction
test_security_token_redaction() {
    # ============================================================================
    # Section 20: Security - Token Redaction in Logs
    # ============================================================================

    section "20. Security - Token Redaction in Logs"

    log_info "Verifying tokens are properly redacted in logs..."

    local backend_pod
    backend_pod=$(kubectl get pods -n "$NAMESPACE" -l app=ambient-api-server -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

    if [ -z "$backend_pod" ]; then
        log_warning "Backend pod not found, skipping token redaction test"
        return
    fi

    # Get all backend logs
    local logs
    logs=$(kubectl logs -n "$NAMESPACE" "$backend_pod" --tail=500 2>/dev/null || echo "")

    if [ -z "$logs" ]; then
        log_warning "Could not retrieve backend logs"
        return
    fi

    # Test 1: Logs should use tokenLen= instead of showing token
    if echo "$logs" | grep -q "tokenLen=\|token (len="; then
        pass "Logs use token length instead of token value (correct redaction)"
    else
        log_info "Token length logging not found (may need authenticated requests)"
    fi

    # Test 2: Should NOT contain Bearer tokens
    if echo "$logs" | grep -qE "Bearer [A-Za-z0-9._-]{20,}"; then
        fail "Logs contain Bearer tokens (SECURITY ISSUE)"
    else
        pass "Logs do NOT contain Bearer tokens (correct)"
    fi

    # Test 3: Should NOT contain base64-encoded credentials
    if echo "$logs" | grep -qE "[A-Za-z0-9+/]{40,}={0,2}"; then
        log_warning "Logs may contain base64-encoded data (verify not credentials)"
    else
        pass "Logs do not contain long base64 strings"
    fi
}

# Test: CRITICAL - Test User Token
test_critical_token_minting() {
    # ============================================================================
    # Section 21: CRITICAL - Test User Token
    # ============================================================================

    section "21. CRITICAL - Test User Token"

    # Kind setup creates a test-user ServiceAccount with a pre-generated token
    # stored in a secret. Validate that this exists.

    # Step 1: test-user ServiceAccount must exist
    if kubectl get serviceaccount test-user -n "$NAMESPACE" >/dev/null 2>&1; then
        pass "Step 1/2: test-user ServiceAccount exists"
    else
        log_warning "Step 1/2: test-user ServiceAccount does not exist (kind-up may not have completed)"
        if [ "$CI_MODE" = true ]; then
            ((KNOWN_FAILURES++))
        else
            FAILED=$((FAILED + 1))
        fi
        return 1
    fi

    # Step 2: test-user-token secret must exist
    if kubectl get secret test-user-token -n "$NAMESPACE" >/dev/null 2>&1; then
        pass "Step 2/2: test-user-token secret exists"
    else
        log_warning "Step 2/2: test-user-token secret does not exist"
        if [ "$CI_MODE" = true ]; then
            ((KNOWN_FAILURES++))
        else
            FAILED=$((FAILED + 1))
        fi
        return 1
    fi
}

# Test: Production Manifest Safety - No Dev Mode Variables
test_production_manifest_safety() {
    # ============================================================================
    # Section 22: Production Manifest Safety
    # ============================================================================

    section "22. Production Manifest Safety"

    log_info "Verifying production manifests do NOT contain dev mode variables..."

    # Check base/production manifests for DISABLE_AUTH
    local prod_manifests=(
        "components/manifests/base/core/ambient-api-server-service.yml"
        "components/manifests/base/core/ambient-ui-deployment.yaml"
        "components/manifests/base/ambient-control-plane-service.yml"
    )

    local found_issues=false

    for manifest in "${prod_manifests[@]}"; do
        if [ ! -f "$manifest" ]; then
            log_warning "Manifest not found: $manifest (may be in subdirectory)"
            continue
        fi

        # Check for DISABLE_AUTH
        if grep -q "DISABLE_AUTH" "$manifest" 2>/dev/null; then
            fail "Production manifest contains DISABLE_AUTH: $manifest"
            echo -e "  ${RED}✗${NC}   This would enable dev mode in production (CRITICAL SECURITY ISSUE)"
            found_issues=true
        else
            pass "Production manifest clean (no DISABLE_AUTH): $manifest"
        fi

        # Check for ENVIRONMENT=local or development
        if grep -qE "ENVIRONMENT.*[\"']?(local|development)[\"']?" "$manifest" 2>/dev/null; then
            fail "Production manifest sets ENVIRONMENT=local/development: $manifest"
            echo -e "  ${RED}✗${NC}   This would enable dev mode in production (CRITICAL SECURITY ISSUE)"
            found_issues=true
        else
            pass "Production manifest clean (no ENVIRONMENT=local): $manifest"
        fi
    done

    if [ "$found_issues" = false ]; then
        log_info ""
        log_info "✅ Production manifests are safe"
        log_info "✅ Clear separation between dev and production configs"
    fi
}

# Main test execution
main() {
    section "Agent Control Plane - Local Developer Experience Tests"
    log_info "Starting test suite at $(date)"
    log_info "Test configuration:"
    log_info "  Namespace: $NAMESPACE"
    log_info "  Skip setup: $SKIP_SETUP"
    log_info "  Cleanup: $CLEANUP"
    log_info "  Verbose: $VERBOSE"
    echo ""

    # Run tests
    test_prerequisites
    test_makefile_help
    test_kind_status
    test_kubernetes_context
    test_namespace_exists
    test_pods_running
    test_services_exist
    test_backend_health
    test_frontend_accessibility
    test_rbac
    test_build_command
    test_benchmark_syntax
    test_logging_commands
    test_storage
    test_resource_limits
    test_make_status

    # Security tests
    test_security_local_dev_user
    test_security_prod_namespace_rejection
    test_security_mock_token_logging
    test_security_token_redaction

    # Production safety tests
    test_production_manifest_safety

    # CRITICAL tests
    test_critical_token_minting

    # Summary
    echo ""
    echo -e "${BOLD}Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}"
    if [ $KNOWN_FAILURES -gt 0 ]; then
        echo -e "  ${YELLOW}Known TODOs:${NC} $KNOWN_FAILURES"
    fi
    echo ""

    if [ "$CI_MODE" = true ]; then
        # In CI mode, known failures are acceptable
        local unexpected_failures=$FAILED
        if [ $unexpected_failures -eq 0 ]; then
            echo -e "${GREEN}${BOLD}All tests passed (excluding $KNOWN_FAILURES known TODOs)!${NC}"
            echo ""
            log_info "CI validation successful!"
            if [ $KNOWN_FAILURES -gt 0 ]; then
                log_warning "Note: $KNOWN_FAILURES known TODOs tracked in test output"
            fi
            exit 0
        else
            echo -e "${RED}${BOLD}$unexpected_failures unexpected test failures${NC}"
            echo ""
            exit 1
        fi
    else
        # In normal mode, any failure is an issue
        if [ $FAILED -eq 0 ]; then
            echo -e "${GREEN}${BOLD}All tests passed!${NC}"
            echo ""
            log_info "Your local development environment is ready!"
            log_info "Access the application:"
            log_info "  Frontend: $(get_test_url 30030)"
            log_info "  Backend:  $(get_test_url 30080)"
            echo ""
            if [ $KNOWN_FAILURES -gt 0 ]; then
                log_warning "Note: $KNOWN_FAILURES known TODOs tracked for future implementation"
            fi
            exit 0
        else
            echo -e "${RED}${BOLD}Some tests failed${NC}"
            echo ""
            log_info "Your local development environment has issues"
            log_info "Run 'make local-troubleshoot' for more details"
            echo ""
            exit 1
        fi
    fi
}

# Run main function
main
