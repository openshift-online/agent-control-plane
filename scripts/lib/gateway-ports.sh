#!/usr/bin/env bash
#
# gateway-ports.sh — Single source of truth for the OpenShell gateway
# tenant->local-port mapping used by kind port-forwarding, kind-status, and
# setup-gateway-cli.sh.
#
# Formula: port(ns) = BASE + zero-based index of ns in OPENSHELL_TENANTS.
#
# Environment:
#   OPENSHELL_TENANTS           space-separated tenant list
#                               (default: tenant-a tenant-b tenant-c
#                                vteam-product-swarm codebase-maintainers)
#   KIND_FWD_GATEWAY_BASE_PORT  base port (preferred; default via GATEWAY_BASE_PORT/15080)
#   GATEWAY_BASE_PORT           base port fallback (default: 15080)
#
# Sourceable:   gateway_port_for <ns>   -> echoes port, returns 0/1
# Executable:   gateway-ports.sh port-for <ns>
#               gateway-ports.sh list

_gw_tenants() {
  echo "${OPENSHELL_TENANTS:-tenant-a tenant-b tenant-c vteam-product-swarm codebase-maintainers}"
}

_gw_base_port() {
  echo "${KIND_FWD_GATEWAY_BASE_PORT:-${GATEWAY_BASE_PORT:-15080}}"
}

# gateway_port_for <ns>: echo BASE+index; return 1 if ns not in the tenant list.
gateway_port_for() {
  local target="$1" base idx=0 ns
  base="$(_gw_base_port)"
  for ns in $(_gw_tenants); do
    if [ "$ns" = "$target" ]; then
      echo "$((base + idx))"
      return 0
    fi
    idx=$((idx + 1))
  done
  echo "gateway-ports: unknown tenant '$target' (not in OPENSHELL_TENANTS)" >&2
  return 1
}

# gateway_list: echo "<ns> <port>" for every tenant.
gateway_list() {
  local ns
  for ns in $(_gw_tenants); do
    echo "$ns $(gateway_port_for "$ns")"
  done
}

# CLI dispatch only when executed directly (not sourced).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    port-for) shift; gateway_port_for "${1:?usage: gateway-ports.sh port-for <ns>}" ;;
    list)     gateway_list ;;
    *) echo "usage: gateway-ports.sh {port-for <ns>|list}" >&2; exit 2 ;;
  esac
fi
