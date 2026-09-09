#!/usr/bin/env python3
"""Allow one managed gateway sandbox account to pull the ACP runner image."""
import argparse
import json
import os
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('gateway_namespace')
parser.add_argument('--image-namespace', default='acp-hypershell')
parser.add_argument('--hypershell-instance', default='acp-hypershell-system')
parser.add_argument('--sandbox-service-account', default='default')
args = parser.parse_args()
context = os.environ.get('ACP_OC_CONTEXT')
if not context:
    parser.error('Set ACP_OC_CONTEXT')
oc = ['oc', '--context=' + context]
namespace = json.loads(subprocess.check_output(oc + ['get', 'namespace', args.gateway_namespace, '-o', 'json'], text=True))
labels = namespace['metadata'].get('labels', {})
if labels.get('hypershell.redhat.io/instance') != args.hypershell_instance or labels.get('hypershell.redhat.io/managed') != 'true':
    parser.error('The namespace is not managed by the selected Hypershell instance')
role_name = 'acp-runner-image-pull'
items = [
    {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'Role',
     'metadata': {'name': role_name, 'namespace': args.image_namespace},
     'rules': [{'apiGroups': ['image.openshift.io'], 'resources': ['imagestreams/layers'],
                'resourceNames': ['acp-claude-runner'], 'verbs': ['get']}]},
    {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'RoleBinding',
     'metadata': {'name': role_name + '-' + args.gateway_namespace, 'namespace': args.image_namespace,
                  'ownerReferences': [{'apiVersion': 'v1', 'kind': 'Namespace', 'name': args.gateway_namespace,
                                       'uid': namespace['metadata']['uid']}]},
     'roleRef': {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': role_name},
     'subjects': [{'kind': 'ServiceAccount', 'namespace': args.gateway_namespace,
                   'name': args.sandbox_service_account}]},
]
subprocess.run(oc + ['apply', '-f', '-'], input=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': items}), text=True, check=True)
