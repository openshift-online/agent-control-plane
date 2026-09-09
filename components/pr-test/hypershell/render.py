#!/usr/bin/env python3
"""Render ACP resources for an existing Hypershell service and OIDC realm."""
import argparse
import json
from pathlib import Path


def postgres_identity(pod, image):
    """Give the assigned OpenShift UID a passwd entry with a read-only root."""
    pod['volumes'].append({'name': 'postgres-identity', 'emptyDir': {}})
    pod['containers'][0]['volumeMounts'].append({'name': 'postgres-identity',
        'mountPath': '/etc/passwd', 'subPath': 'passwd', 'readOnly': True})
    pod.setdefault('initContainers', []).append({'name': 'postgres-identity', 'image': image,
        'command': ['sh', '-c', 'cp /etc/passwd /identity/passwd; printf "runtime:x:%s:%s:Runtime user:/tmp:/sbin/nologin\\n" "$(id -u)" "$(id -g)" >> /identity/passwd'],
        'securityContext': {'runAsNonRoot': True, 'readOnlyRootFilesystem': True,
            'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
        'resources': {'requests': {'cpu': '10m', 'memory': '32Mi'}, 'limits': {'cpu': '100m', 'memory': '64Mi'}},
        'volumeMounts': [{'name': 'postgres-identity', 'mountPath': '/identity'}]})


def render(config):
    namespace = config['namespace']
    domain = config['apps_domain']
    issuer = config['oidc_issuer'].rstrip('/')
    images = config['images']
    cp_client = config['cp_client_id']
    ui_client = config['ui_client_id']
    ui_host = f'ambient-ui-{namespace}.{domain}'
    api_host = f'ambient-api-server-{namespace}.{domain}'
    cp_host = f'ambient-control-plane-{namespace}.{domain}'
    grpc_host = f'ambient-api-grpc-{namespace}.{domain}'
    items = []

    def add(kind, name, spec=None, api='v1', **fields):
        obj = {'apiVersion': api, 'kind': kind, 'metadata': {'name': name,
               'namespace': namespace, 'labels': {'app.kubernetes.io/part-of': 'acp-hypershell'}}}
        if spec is not None:
            obj['spec'] = spec
        obj.update(fields)
        items.append(obj)
        return obj

    def env(name, value):
        return {'name': name, 'value': str(value)}

    def secret_env(name, secret, key):
        return {'name': name, 'valueFrom': {'secretKeyRef': {'name': secret, 'key': key}}}

    def mount(name, path, readonly=False):
        return {'name': name, 'mountPath': path, 'readOnly': readonly}

    def service(name, ports):
        return add('Service', name, {'selector': {'app': name}, 'ports': [
            {'name': label, 'port': port, 'targetPort': port} for label, port in ports]})

    def deployment(name, image, environment, ports, mounts=None, volumes=None, command=None, probe=None):
        container = {'name': name, 'image': image, 'imagePullPolicy': 'IfNotPresent',
            'securityContext': {'runAsNonRoot': True, 'allowPrivilegeEscalation': False,
                'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
            'env': environment, 'ports': [{'containerPort': p} for p in ports],
            'resources': {'requests': {'cpu': '50m', 'memory': '128Mi'},
                'limits': {'cpu': '2', 'memory': '1Gi'}},
            'volumeMounts': [mount('tmp', '/tmp')] + (mounts or [])}
        if command:
            container['command'] = command
        if probe:
            container['readinessProbe'] = dict(probe, initialDelaySeconds=5, periodSeconds=5)
            container['livenessProbe'] = dict(probe, initialDelaySeconds=30, periodSeconds=10)
        obj = add('Deployment', name, {'replicas': 1,
            'selector': {'matchLabels': {'app': name}}, 'template': {
                'metadata': {'labels': {'app': name}}, 'spec': {
                    'serviceAccountName': name,
                    'securityContext': {'runAsNonRoot': True, 'seccompProfile': {'type': 'RuntimeDefault'}},
                    'containers': [container], 'volumes': [{'name': 'tmp', 'emptyDir': {}}] + (volumes or [])}}},
            api='apps/v1')
        add('ServiceAccount', name, automountServiceAccountToken=name in ('ambient-control-plane', 'ambient-api-server'))
        return obj

    # Use a PVC so pod replacement does not erase the review environment.
    add('PersistentVolumeClaim', 'ambient-api-server-db', {'accessModes': ['ReadWriteOnce'],
        'resources': {'requests': {'storage': config.get('database_storage', '5Gi')}},
        **({'storageClassName': config['storage_class']} if config.get('storage_class') else {})})
    db = deployment('ambient-api-server-db', images['postgres'], [
        secret_env('POSTGRES_DB', 'ambient-api-server-db', 'db.name'),
        secret_env('POSTGRES_USER', 'ambient-api-server-db', 'db.user'),
        secret_env('POSTGRES_PASSWORD', 'ambient-api-server-db', 'db.password'),
        env('PGDATA', '/var/lib/postgresql/data/pgdata')], [5432],
        [mount('data', '/var/lib/postgresql/data'), mount('socket', '/var/run/postgresql')],
        [{'name': 'data', 'persistentVolumeClaim': {'claimName': 'ambient-api-server-db'}},
         {'name': 'socket', 'emptyDir': {}}], probe={'tcpSocket': {'port': 5432}})
    db['spec']['strategy'] = {'type': 'Recreate'}
    postgres_identity(db['spec']['template']['spec'], images['postgres'])
    service('ambient-api-server-db', [('postgres', 5432)])

    add('ConfigMap', 'ambient-api-server-auth', data={'jwks.json': '{"keys":[]}'})
    db_args = [f'--db-{key}-file=/secrets/db/db.{key}' for key in ['host', 'port', 'user', 'password', 'name']]
    db_args += ['--db-sslmode=disable']
    api = deployment('ambient-api-server', images['api_server'], [
        env('AMBIENT_ENV', 'production'), env('GRPC_SERVICE_ACCOUNT', cp_client),
        secret_env('CREDENTIAL_ENCRYPTION_KEYRING', 'credential-encryption-key', 'keyring'),
        secret_env('CREDENTIAL_ENCRYPTION_KEY_VERSION', 'credential-encryption-key', 'version'),
        env('CREDENTIAL_ENCRYPTION_ALLOW_PLAINTEXT', 'false'),
        env('AMBIENT_RUNNER_PUBLIC_KEY_FILE', '/secrets/runner-key/public.pem')], [8000, 9000, 4434],
        [mount('db', '/secrets/db', True), mount('service', '/secrets/service', True),
         mount('auth', '/configs/authentication', True), mount('grpc-tls', '/secrets/grpc-tls', True),
         mount('runner-key', '/secrets/runner-key', True)],
        [{'name': 'db', 'secret': {'secretName': 'ambient-api-server-db'}},
         {'name': 'service', 'secret': {'secretName': 'ambient-api-server'}},
         {'name': 'auth', 'configMap': {'name': 'ambient-api-server-auth'}},
         {'name': 'grpc-tls', 'secret': {'secretName': 'ambient-api-server-tls'}},
         {'name': 'runner-key', 'secret': {'secretName': 'ambient-cp-token-keypair', 'items': [{'key': 'public.pem', 'path': 'public.pem'}]}}],
        ['/usr/local/bin/ambient-api-server', 'serve'] + db_args + [
            '--enable-jwt=true', '--enable-authz=true',
            f'--jwk-cert-url={issuer}/protocol/openid-connect/certs',
            '--jwk-cert-file=/configs/authentication/jwks.json', '--enable-https=false',
            '--enable-grpc=true', '--api-server-bindaddress=:8000',
            '--metrics-server-bindaddress=:4433', '--health-check-server-bindaddress=:4434',
            '--enable-metrics-https=false', '--grpc-server-bindaddress=:9000',
            '--grpc-enable-tls=true', '--grpc-tls-cert-file=/secrets/grpc-tls/tls.crt',
            '--grpc-tls-key-file=/secrets/grpc-tls/tls.key', '--enable-db-debug=false', '--alsologtostderr'],
        {'httpGet': {'path': '/healthcheck', 'port': 4434}})
    api['spec']['template']['spec']['initContainers'] = [{
        'name': 'migrate', 'image': images['api_server'],
        'command': ['/usr/local/bin/ambient-api-server', 'migrate'] + db_args,
        'securityContext': {'runAsNonRoot': True, 'readOnlyRootFilesystem': True,
            'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
        'volumeMounts': [mount('db', '/secrets/db', True), mount('tmp', '/tmp')]}]
    api_service = service('ambient-api-server', [('api', 8000), ('grpc', 9000)])
    api_service['metadata']['annotations'] = {'service.beta.openshift.io/serving-cert-secret-name': 'ambient-api-server-tls'}

    cp_env = [env('MODE', 'kube'), env('PLATFORM_MODE', 'standard'),
        env('NAMESPACE', namespace), env('CP_RUNTIME_NAMESPACE', namespace),
        env('AMBIENT_API_SERVER_URL', f'http://ambient-api-server.{namespace}.svc:8000'),
        env('AMBIENT_GRPC_SERVER_ADDR', f'ambient-api-server.{namespace}.svc:9000'),
        env('AMBIENT_GRPC_USE_TLS', 'true'), env('OIDC_TOKEN_URL', f'{issuer}/protocol/openid-connect/token'),
        env('OIDC_CLIENT_ID', cp_client),
        secret_env('OIDC_CLIENT_SECRET', 'ambient-control-plane-oidc', 'client-secret'),
        env('RUNNER_IMAGE', images['runner']), env('OPENSHELL_ENABLED', 'true'),
        env('ACP_RUNTIME_BACKEND', 'hypershell'),
        env('AMBIENT_RUNNER_GRPC_ADDR', f'{grpc_host}:443'),
        env('AMBIENT_RUNNER_TOKEN_URL', f'https://{cp_host}/token'),
        env('CP_TOKEN_URL', f'https://{cp_host}/token')]
    # The integration owns its connection variable names. Accept Kubernetes EnvVar
    # records to support Secret references without writing credentials to config.
    overrides = {entry['name']: entry for entry in config['control_plane_env']}
    cp_env = [overrides.pop(entry['name'], entry) for entry in cp_env] + list(overrides.values())
    deployment('ambient-control-plane', images['control_plane'], cp_env, [8080],
        probe={'tcpSocket': {'port': 8080}})
    service('ambient-control-plane', [('token', 8080)])
    add('Role', 'ambient-control-plane', api='rbac.authorization.k8s.io/v1', rules=[
        {'apiGroups': [''], 'resources': ['secrets', 'configmaps'],
         'verbs': ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete']}])
    add('RoleBinding', 'ambient-control-plane', api='rbac.authorization.k8s.io/v1',
        subjects=[{'kind': 'ServiceAccount', 'name': 'ambient-control-plane', 'namespace': namespace}],
        roleRef={'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': 'ambient-control-plane'})

    deployment('ambient-ui', images['ui'], [env('NODE_ENV', 'production'),
        env('API_SERVER_URL', 'http://ambient-api-server:8000'),
        env('CONTROL_PLANE_URL', 'http://ambient-control-plane:8080'),
        env('SSO_ISSUER_URL', issuer), env('SSO_FRONTEND_ISSUER_URL', issuer),
        env('SSO_CLIENT_ID', ui_client), env('SSO_AUDIENCE', ui_client),
        env('SSO_REDIRECT_URI', f'https://{ui_host}/api/auth/sso/callback'),
        secret_env('SSO_CLIENT_SECRET', 'sso-credentials', 'SSO_CLIENT_SECRET'),
        secret_env('SESSION_SECRET', 'sso-credentials', 'SESSION_SECRET')], [3000],
        [mount('cache', '/app/.next/cache')], [{'name': 'cache', 'emptyDir': {}}],
        probe={'httpGet': {'path': '/api/healthz', 'port': 3000}})
    service('ambient-ui', [('http', 3000)])
    for name, host, port in [('ambient-ui', ui_host, 'http'),
                             ('ambient-api-server', api_host, 'api'),
                             ('ambient-control-plane', cp_host, 'token')]:
        add('Route', name, {'host': host, 'to': {'kind': 'Service', 'name': name},
            'port': {'targetPort': port}, 'tls': {'termination': 'edge',
            'insecureEdgeTerminationPolicy': 'Redirect'}}, api='route.openshift.io/v1')
    add('Route', 'ambient-api-grpc', {'host': grpc_host,
        'to': {'kind': 'Service', 'name': 'ambient-api-server'}, 'port': {'targetPort': 'grpc'},
        'tls': {'termination': 'reencrypt', 'insecureEdgeTerminationPolicy': 'Redirect',
                **({'destinationCACertificate': config['service_ca']} if config.get('service_ca') else {})}},
        api='route.openshift.io/v1')
    return {'apiVersion': 'v1', 'kind': 'List', 'items': items}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    args = parser.parse_args()
    print(json.dumps(render(json.loads(args.config.read_text())), indent=2))
