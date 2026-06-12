---
title: Mounting a Custom CA Bundle
description: How to configure ACP to trust certificates from a private or corporate CA
---

Use a custom CA bundle when ACP components must call services with certificates signed by an internal CA: Git hosts, OIDC issuers, artifact systems, or internal APIs.

## What is built in

OpenShift service CA support is already present in several paths:

- OpenShift overlays annotate the API server Service so OpenShift can provision serving certificates.
- The control plane adds `/var/run/secrets/kubernetes.io/serviceaccount/service-ca.crt` to its HTTP and gRPC trust pool when that file exists.
- Runner Pods mount a ConfigMap named `openshift-service-ca.crt` at `/etc/pki/ca-trust/extracted/pem/service-ca.crt`.
- Runner containers set `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` to that mounted file.

That covers OpenShift service certificates. A separate corporate CA still needs to be mounted or baked into images for the components that call corporate services.

## Create a CA bundle ConfigMap

Create the bundle in each namespace where a component needs outbound trust.

```bash
kubectl create configmap trusted-ca-bundle \
  --from-file=ca-bundle.crt=./corp-ca-bundle.crt \
  -n ambient-code
```

For runner Pods, remember they run in project namespaces, not only the control-plane namespace.

## Patch API server and control plane Deployments

Mount the bundle and set standard trust environment variables:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ambient-api-server
spec:
  template:
    spec:
      volumes:
        - name: trusted-ca-bundle
          configMap:
            name: trusted-ca-bundle
      containers:
        - name: api-server
          env:
            - name: SSL_CERT_FILE
              value: /etc/pki/custom-ca/ca-bundle.crt
            - name: REQUESTS_CA_BUNDLE
              value: /etc/pki/custom-ca/ca-bundle.crt
          volumeMounts:
            - name: trusted-ca-bundle
              mountPath: /etc/pki/custom-ca
              readOnly: true
```

Apply the same pattern to `ambient-control-plane` if it must trust the same internal endpoints.

## Runner Pods

The current reconciler hardcodes a runner volume from ConfigMap `openshift-service-ca.crt`, key `service-ca.crt`, and points `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` at that file.

For OpenShift service CA, let the platform manage that ConfigMap in each project namespace.

For a different corporate CA, use one of these approaches:

- create `openshift-service-ca.crt` with key `service-ca.crt` in each project namespace containing the corporate bundle, if that does not conflict with your OpenShift service CA flow.
- update the control-plane reconciler/manifests to mount a separate ConfigMap and set runner trust paths.
- bake the corporate CA into the runner image's system trust store.

Do not assume a ConfigMap in the control-plane namespace will automatically appear in project namespaces.

## Verify

After rollout, test from the component that makes the outbound call:

```bash
kubectl exec deploy/ambient-api-server -n ambient-code -- \
  sh -c 'test -f /etc/pki/custom-ca/ca-bundle.crt && echo ok'
```

For runner trust, start a test session in the target project and have the agent run a TLS request to the internal host.
