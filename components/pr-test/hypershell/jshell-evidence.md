# jshell deployment evidence

This record covers infrastructure preparation. ACP session approval tests are
still required. All cluster commands used this explicit context:

`default/api-jshell-8u58-p3-openshiftapps-com:443/johnsell`

## Storage repair

The CSI credential Secret named an IAM role that no longer existed. The cluster
OIDC provider still existed. AWS account: `765374464689`; region: `us-east-1`.

Restored role:

`jsell-hypershell-dev-yffe-openshift-cluster-csi-drivers-ebs-clou`

The trust policy is in `jshell-csi-trust.json`. It permits only the CSI controller
and operator service accounts from this cluster. The attached AWS policy is:

`arn:aws:iam::aws:policy/service-role/ROSAAmazonEBSCSIDriverOperatorPolicy`

A temporary attachment of `AmazonEBSCSIDriverPolicy` was removed. The final
role has only the ROSA policy. Both the default CSI request and the dedicated
storage class carry `red-hat-managed=true`. IAM propagation caused a delay after
restoration. A fresh CSI identity passed an EC2 CreateVolume dry-run.

A restricted test pod used a 1Gi PVC on `acp-hypershell-gp3`. The PVC became
Bound, and the pod wrote and read `storage-ok`. The test pod and PVC were then
deleted. The shared default storage class was not changed.

To remove the restored role after all dependent storage has been removed:

```bash
aws iam detach-role-policy \
  --role-name jsell-hypershell-dev-yffe-openshift-cluster-csi-drivers-ebs-clou \
  --policy-arn arn:aws:iam::aws:policy/service-role/ROSAAmazonEBSCSIDriverOperatorPolicy
aws iam delete-role \
  --role-name jsell-hypershell-dev-yffe-openshift-cluster-csi-drivers-ebs-clou
```

These commands undo the repair and stop CSI storage operations. They were not run.

## Isolated Hypershell

Namespace: `acp-hypershell-system`.

API: `https://hypershell-api-acp-hypershell-system.apps.rosa.jshell.8u58.p3.openshiftapps.com`

The first API and controller images came from Hypershell commit
`433388cee436699009ac652b5cc4c3bd0cfb8aeb`. Follow-up storage and deletion fixes
require a final image rebuild before approval tests. The existing shared
Hypershell deployments were not upgraded.

PostgreSQL has a bound 5Gi PVC. A restricted init container supplies a passwd
entry for the assigned OpenShift UID. PostgreSQL keeps a read-only root
filesystem. No SCC exception was needed.

Authenticated manager requests to `managed_clusters` and `gateways` returned
HTTP 200. Dedicated records were created through the API:

| Record | ID |
| --- | --- |
| Managed cluster `acp-jshell` | `3J69rJC7eofC9F9XiVJtABWBdkw` |
| Gateway image release `acp-openshell-v0.0.109-rhaiv.0` | `3J69rGTlaomdv8DOCcx3bgiWiHO` |

The cluster record refers to a kubeconfig that uses the controller pod's service
account token file. It contains no copied bearer token.

## ACP preparation

Namespace: `acp-hypershell`.

Dedicated OIDC clients are `acp-hypershell-ui`, `acp-hypershell-cp`, and
`acp-hypershell-manager`. The manager has the `gateway:creator` realm role.
Hypershell uses the separate `acp-hypershell-service` client for its controller.

The ACP database password, RSA runner keypair, credential encryption keyring,
and UI session key are in Kubernetes Secrets. Repeat setup preserves these
values. The API has plaintext credential storage disabled.

Operator configuration and client secret files are in the local directory
`/home/jsell/.cache/acp-hypershell-jshell`. The directory has mode `0700` and
secret files have mode `0600`. These files are not in source control. The ACP
configuration file is `config.json`; its image references must be replaced with
the final build digests.

The jshell and Keycloak HTTPS certificates pass system trust verification.
The ACP manifest uses a reencrypt Route for public gRPC and a service-issued
certificate for the API gRPC listener. The token callback uses an HTTPS Route.

The three worker nodes have limited memory request capacity. Only the new test
workload requests were reduced. Two concurrent agent sessions can require more
worker capacity; this must be checked during the session tests.
