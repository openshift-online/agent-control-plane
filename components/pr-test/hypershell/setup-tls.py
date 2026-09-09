#!/usr/bin/env python3
"""Create a private test CA and a TLS certificate for public ACP gRPC."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('config', type=Path)
parser.add_argument('--cert-manager-namespace', default='cert-manager')
args = parser.parse_args()
context = os.environ.get('ACP_OC_CONTEXT')
if not context:
    parser.error('Set ACP_OC_CONTEXT')
oc = ['oc', '--context=' + context]
config = json.loads(args.config.read_text())
namespace = config['namespace']
issuer_name = namespace + '-test-ca'
root_namespace = args.cert_manager_namespace

def apply(items):
    subprocess.run(oc + ['apply', '-f', '-'], input=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': items}), text=True, check=True)

def resource(kind, name, namespace, spec):
    meta = {'name': name, 'labels': {'app.kubernetes.io/part-of': 'acp-hypershell'}}
    if namespace:
        meta['namespace'] = namespace
    return {'apiVersion': 'cert-manager.io/v1', 'kind': kind, 'metadata': meta, 'spec': spec}

apply([
    resource('Issuer', issuer_name + '-selfsigned', root_namespace, {'selfSigned': {}}),
    resource('Certificate', issuer_name, root_namespace, {'isCA': True, 'commonName': issuer_name,
        'secretName': issuer_name, 'duration': '8760h', 'renewBefore': '720h',
        'privateKey': {'algorithm': 'ECDSA', 'size': 256, 'rotationPolicy': 'Always'},
        'issuerRef': {'name': issuer_name + '-selfsigned', 'kind': 'Issuer'}}),
    resource('ClusterIssuer', issuer_name, None, {'ca': {'secretName': issuer_name}}),
    resource('Certificate', 'ambient-api-grpc', namespace, {'secretName': 'ambient-api-grpc-tls',
        'dnsNames': [f'ambient-api-grpc-{namespace}.{config["apps_domain"]}',
            f'ambient-api-server.{namespace}.svc', f'ambient-api-server.{namespace}.svc.cluster.local'],
        'privateKey': {'algorithm': 'ECDSA', 'size': 256, 'rotationPolicy': 'Always'},
        'issuerRef': {'name': issuer_name, 'kind': 'ClusterIssuer'}}),
])
subprocess.run(oc + ['wait', 'certificate/' + issuer_name, '-n', root_namespace, '--for=condition=Ready', '--timeout=60s'], check=True)
subprocess.run(oc + ['wait', 'certificate/ambient-api-grpc', '-n', namespace, '--for=condition=Ready', '--timeout=60s'], check=True)
# Only the public certificate enters the ConfigMap. The CA private key stays
# in the cert-manager namespace and is never copied to ACP or the local disk.
root = json.loads(subprocess.check_output(oc + ['get', 'secret', issuer_name, '-n', root_namespace, '-o', 'json'], text=True))
ca = base64.b64decode(root['data']['tls.crt']).decode()
trust = Path('/etc/ssl/certs/ca-certificates.crt').read_text() + '\n' + ca
apply([{'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'acp-runtime-ca', 'namespace': namespace}, 'data': {'ca-bundle.pem': trust}}])
config['api_tls'] = True
config['api_tls_ca'] = ca
config['grpc_tls_secret'] = 'ambient-api-grpc-tls'
config['grpc_route_termination'] = 'passthrough'
config['runtime_ca_configmap'] = 'acp-runtime-ca'
args.config.write_text(json.dumps(config, indent=2))
os.chmod(args.config, 0o600)
print('Private test issuer: ' + issuer_name)
print('Public trust bundle is ready; run the ACP renderer to use it.')
