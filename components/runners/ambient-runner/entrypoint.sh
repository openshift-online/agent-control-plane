#!/bin/bash
# ACP Runner entrypoint for OpenShell sandbox containers.
#
# Patches /etc/resolv.conf to work around a musl libc DNS issue:
# the OpenShell supervisor is statically linked with musl, whose getaddrinfo
# sends simultaneous A+AAAA queries on one socket. Combined with Kubernetes'
# default ndots:5, external domains like aiplatform.googleapis.com get expanded
# through all search domains first (60+ queries), causing response mismatching
# and zero usable addresses. Setting ndots:1 makes musl resolve FQDNs directly.

if [ -f /etc/resolv.conf ] && ! grep -q 'ndots:1' /etc/resolv.conf 2>/dev/null; then
    sed -i 's/ndots:[0-9]*/ndots:1/' /etc/resolv.conf 2>/dev/null || true
fi

cd /runner/ambient-runner
exec uvicorn main:app --host 0.0.0.0 --port 8001
