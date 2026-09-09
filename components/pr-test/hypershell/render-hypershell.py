#!/usr/bin/env python3
"""Render an isolated Hypershell service from its committed source manifests."""
import argparse
import json
from pathlib import Path
import yaml
from render import postgres_identity

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('config', type=Path)
args = parser.parse_args()
config = json.loads(args.config.read_text())
namespace = config['namespace']
issuer = config['oidc_issuer'].rstrip('/')
source_files = ['api-server.yaml', 'controller.yaml', 'controller-rbac.yaml', 'postgres.yaml',
                'certificates/ca-chain.yaml', 'networkpolicies.yaml']
items = []
for filename in source_files:
    for obj in yaml.safe_load_all((args.source / 'deploy/base' / filename).read_text()):
        if not obj or obj['kind'] == 'Secret':
            continue
        meta = obj['metadata']
        if 'namespace' in meta:
            meta['namespace'] = namespace
        if obj['kind'] in ('ClusterRole', 'ClusterRoleBinding'):
            meta['name'] = namespace + '-controller'
        if obj['kind'] == 'ClusterRoleBinding':
            obj['roleRef']['name'] = namespace + '-controller'
            obj['subjects'][0]['namespace'] = namespace
        if obj['kind'] == 'Deployment':
            name = meta['name']
            obj['spec']['strategy'] = {'type': 'Recreate'}
            pod = obj['spec']['template']['spec']
            pod['securityContext'] = {'runAsNonRoot': True, 'seccompProfile': {'type': 'RuntimeDefault'}}
            pod.setdefault('volumes', []).append({'name': 'tmp', 'emptyDir': {}})
            for container in pod.get('containers', []) + pod.get('initContainers', []):
                container.setdefault('resources', {})['requests'] = {'cpu': '50m', 'memory': '64Mi'}
                container['securityContext'] = {'runAsNonRoot': True, 'readOnlyRootFilesystem': True,
                    'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}}
                container.setdefault('volumeMounts', []).append({'name': 'tmp', 'mountPath': '/tmp'})
                for entry in container.get('env', []):
                    if entry['name'] == 'DB_SSLMODE':
                        entry['value'] = 'disable'
            if name == 'hypershell-postgres':
                pod['volumes'] = [v for v in pod['volumes'] if v['name'] != 'pgdata'] + [
                    {'name': 'pgdata', 'persistentVolumeClaim': {'claimName': 'hypershell-postgres'}},
                    {'name': 'socket', 'emptyDir': {}}]
                pod['containers'][0]['volumeMounts'].append({'name': 'socket', 'mountPath': '/var/run/postgresql'})
                postgres_identity(pod, pod['containers'][0]['image'])
            elif name == 'hypershell-api-server':
                for container in pod['containers'] + pod['initContainers']:
                    container['image'] = config['api_image']
                container = pod['containers'][0]
                container['command'] = [arg for arg in container['command'] if not arg.startswith(('--enable-authz=', '--enable-jwt='))]
                container['command'] += ['--enable-jwt=true', '--enable-authz=true',
                    '--enable-https=false', '--enable-metrics-https=false', '--enable-grpc=true',
                    '--grpc-enable-tls=false', '--jwk-cert-url=' + issuer + '/protocol/openid-connect/certs']
                container['env'] += [{'name': 'API_ENV', 'value': 'development_oidc'},
                    {'name': 'RBAC_ENFORCE', 'value': 'true'},
                    {'name': 'RBAC_SERVICE_ACCOUNTS', 'value': 'service-account-' + config['cp_client_id']}]
            elif name == 'hypershell-controller':
                container = pod['containers'][0]
                container['image'] = config['controller_image']
                patch = {'HYPERSHELL_GRPC_SERVER_ADDR': 'hypershell-api-server.' + namespace + '.svc.cluster.local:9000',
                    'HYPERSHELL_API_SERVER_URL': 'http://hypershell-api-server.' + namespace + '.svc:8000',
                    'GATEWAY_INGRESS_MODE': 'route', 'GATEWAY_API_BASE_DOMAIN': config['apps_domain'],
                    'GATEWAY_API_TLS_ISSUER_NAME': 'hypershell-ca-issuer',
                    'GATEWAY_OIDC_ISSUER_URL': issuer, 'OIDC_ISSUER': issuer,
                    'OIDC_CLIENT_ID': config['cp_client_id'], 'DATABASE_PROVIDER': 'deployment',
                    'DATABASE_STORAGE_CLASS': config['storage_class'],
                    'OPENSHELL_DATABASE_IMAGE': config.get('database_image', 'registry.access.redhat.com/hi/postgresql:18.4@sha256:9b1917bf15a3b3a6a99b94ab75db1bfde3f434990e881c69d527417d2c035a09')}
                for key in ('database_memory_request', 'gateway_memory_request'):
                    if config.get(key):
                        patch[key.upper()] = config[key]
                if config.get('server_tls_cluster_issuer'):
                    patch['GATEWAY_SERVER_TLS_CLUSTER_ISSUER'] = config['server_tls_cluster_issuer']
                container['env'] = [entry for entry in container['env'] if entry['name'] not in patch]
                container['env'] += [{'name': key, 'value': value} for key, value in patch.items()]
                container['env'].append({'name': 'OIDC_CLIENT_SECRET', 'valueFrom': {
                    'secretKeyRef': {'name': 'hypershell-api-config', 'key': 'api-service.clientSecret'}}})
        items.append(obj)
items += [
    {'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim',
     'metadata': {'name': 'hypershell-postgres', 'namespace': namespace},
     'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': config['storage_class'],
              'resources': {'requests': {'storage': '5Gi'}}}},
    {'apiVersion': 'route.openshift.io/v1', 'kind': 'Route',
     'metadata': {'name': 'hypershell-api', 'namespace': namespace},
     'spec': {'host': 'hypershell-api-' + namespace + '.' + config['apps_domain'],
              'to': {'kind': 'Service', 'name': 'hypershell-api-server'}, 'port': {'targetPort': 'http'},
              'tls': {'termination': 'edge', 'insecureEdgeTerminationPolicy': 'Redirect'}}}]
print(json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': items}, indent=2))
