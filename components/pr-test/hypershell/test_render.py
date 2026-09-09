"""Check the TLS and credential boundaries in the test deployment."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from render import render


class RenderTests(unittest.TestCase):
    def setUp(self):
        config = json.loads(Path(__file__).with_name('config.example.json').read_text())
        config.update(api_tls=True, api_tls_ca='public-ca', grpc_tls_secret='grpc-cert',
                      grpc_route_termination='passthrough', runtime_ca_configmap='runtime-ca')
        self.config = config
        self.items = {(item['kind'], item['metadata']['name']): item for item in render(config)['items']}

    def test_both_api_protocols_use_verified_tls(self):
        pod = self.items['Deployment', 'ambient-api-server']['spec']['template']['spec']
        command = pod['containers'][0]['command']
        self.assertIn('--enable-tls=true', command)
        self.assertIn('--tls-auto-detect-kubernetes=false', command)
        self.assertIn('--tls-cert-file=/secrets/grpc-tls/tls.crt', command)
        self.assertEqual(next(v for v in pod['volumes'] if v['name'] == 'grpc-tls')['secret']['secretName'], 'grpc-cert')
        self.assertEqual(self.items['Route', 'ambient-api-grpc']['spec']['tls']['termination'], 'passthrough')
        rest_tls = self.items['Route', 'ambient-api-server']['spec']['tls']
        self.assertEqual(rest_tls['termination'], 'reencrypt')
        self.assertEqual(rest_tls['destinationCACertificate'], 'public-ca')

    def test_consumers_receive_trust_without_private_key(self):
        for component, url_name in [('ambient-control-plane', 'AMBIENT_API_SERVER_URL'), ('ambient-ui', 'API_SERVER_URL')]:
            pod = self.items['Deployment', component]['spec']['template']['spec']
            env = {entry['name']: entry.get('value') for entry in pod['containers'][0]['env']}
            self.assertTrue(env[url_name].startswith('https://'))
            ca = next(v for v in pod['volumes'] if v['name'] == 'runtime-ca')
            self.assertEqual(ca['configMap']['name'], 'runtime-ca')
            self.assertNotIn('secret', ca)
        api = self.items['Deployment', 'ambient-api-server']['spec']['template']['spec']
        key = next(v for v in api['volumes'] if v['name'] == 'runner-key')
        self.assertEqual(key['secret']['items'], [{'key': 'public.pem', 'path': 'public.pem'}])

    def test_migration_and_server_have_separate_log_directories(self):
        pod = self.items['Deployment', 'ambient-api-server']['spec']['template']['spec']
        server = pod['containers'][0]
        migration = next(c for c in pod['initContainers'] if c['name'] == 'migrate')
        server_tmp = next(v['name'] for v in server['volumeMounts'] if v['mountPath'] == '/tmp')
        migration_tmp = next(v['name'] for v in migration['volumeMounts'] if v['mountPath'] == '/tmp')
        self.assertNotEqual(server_tmp, migration_tmp)
        volumes = {v['name']: v for v in pod['volumes']}
        self.assertIn('emptyDir', volumes[server_tmp])
        self.assertIn('emptyDir', volumes[migration_tmp])

    def test_api_request_override_keeps_limit_and_other_requests(self):
        self.config['api_memory_request'] = '48Mi'
        items = {(item['kind'], item['metadata']['name']): item for item in render(self.config)['items']}
        api = items['Deployment', 'ambient-api-server']['spec']['template']['spec']['containers'][0]
        self.assertEqual(api['resources']['requests']['memory'], '48Mi')
        self.assertEqual(api['resources']['limits']['memory'], '1Gi')
        cp = items['Deployment', 'ambient-control-plane']['spec']['template']['spec']['containers'][0]
        self.assertEqual(cp['resources']['requests']['memory'], '64Mi')
        for value in ['0Mi', '-1Mi', '1025Mi', '48', 48, None]:
            with self.subTest(value=value):
                self.config['api_memory_request'] = value
                with self.assertRaises(ValueError):
                    render(self.config)

    def test_hypershell_migration_and_server_have_separate_log_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            base = source / 'deploy/base'
            (base / 'certificates').mkdir(parents=True)
            for name in ('controller.yaml', 'controller-rbac.yaml', 'postgres.yaml',
                         'certificates/ca-chain.yaml', 'networkpolicies.yaml'):
                (base / name).write_text('')
            deployment = {'apiVersion': 'apps/v1', 'kind': 'Deployment',
                'metadata': {'name': 'hypershell-api-server', 'namespace': 'original'},
                'spec': {'template': {'spec': {
                    'containers': [{'name': 'api', 'command': ['serve'], 'env': []}],
                    'initContainers': [{'name': 'migrate', 'command': ['migrate'], 'env': []}]}}}}
            (base / 'api-server.yaml').write_text(json.dumps(deployment))
            config = source / 'config.json'
            config.write_text(json.dumps({'namespace': 'isolated', 'oidc_issuer': 'https://issuer.example',
                'api_image': 'example/api:test', 'cp_client_id': 'controller',
                'storage_class': 'storage', 'apps_domain': 'apps.example'}))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('render-hypershell.py')),
                str(source), str(config)], check=True, capture_output=True, text=True)
            api = next(item for item in json.loads(result.stdout)['items'] if item['kind'] == 'Deployment')
        pod = api['spec']['template']['spec']
        mounts = [next(m['name'] for m in container['volumeMounts'] if m['mountPath'] == '/tmp')
                  for container in (pod['containers'][0], pod['initContainers'][0])]
        self.assertNotEqual(*mounts)
        volumes = {volume['name']: volume for volume in pod['volumes']}
        for name in mounts:
            self.assertIn('emptyDir', volumes[name])

    def test_workspace_storage_is_controller_config_and_separate_from_database(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            base = source / 'deploy/base'
            (base / 'certificates').mkdir(parents=True)
            for name in ('api-server.yaml', 'controller-rbac.yaml', 'postgres.yaml',
                         'certificates/ca-chain.yaml', 'networkpolicies.yaml'):
                (base / name).write_text('')
            deployment = {'apiVersion': 'apps/v1', 'kind': 'Deployment',
                'metadata': {'name': 'hypershell-controller', 'namespace': 'original'},
                'spec': {'template': {'spec': {'containers': [{'name': 'controller', 'env': []}]}}}}
            (base / 'controller.yaml').write_text(json.dumps(deployment))
            config = source / 'config.json'
            values = {'namespace': 'isolated', 'oidc_issuer': 'https://issuer.example',
                'controller_image': 'example/controller:test', 'cp_client_id': 'controller',
                'storage_class': 'database-storage', 'apps_domain': 'apps.example',
                'workspace_storage_class': 'sandbox-storage', 'workspace_default_storage_size': '3Gi'}
            for configured in [True, False]:
                if not configured:
                    values.pop('workspace_storage_class')
                    values.pop('workspace_default_storage_size')
                config.write_text(json.dumps(values))
                result = subprocess.run([sys.executable, str(Path(__file__).with_name('render-hypershell.py')),
                    str(source), str(config)], check=True, capture_output=True, text=True)
                controller = next(item for item in json.loads(result.stdout)['items'] if item['kind'] == 'Deployment')
                env = {entry['name']: entry.get('value') for entry in controller['spec']['template']['spec']['containers'][0]['env']}
                self.assertEqual(env['DATABASE_STORAGE_CLASS'], 'database-storage')
                if configured:
                    self.assertEqual(env['GATEWAY_WORKSPACE_STORAGE_CLASS'], 'sandbox-storage')
                    self.assertEqual(env['GATEWAY_WORKSPACE_DEFAULT_STORAGE_SIZE'], '3Gi')
                else:
                    self.assertNotIn('GATEWAY_WORKSPACE_STORAGE_CLASS', env)
                    self.assertNotIn('GATEWAY_WORKSPACE_DEFAULT_STORAGE_SIZE', env)


if __name__ == '__main__':
    unittest.main()
