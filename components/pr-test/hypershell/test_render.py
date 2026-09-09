"""Check the TLS and credential boundaries in the test deployment."""
import json
from pathlib import Path
import unittest

from render import render


class RenderTests(unittest.TestCase):
    def setUp(self):
        config = json.loads(Path(__file__).with_name('config.example.json').read_text())
        config.update(api_tls=True, api_tls_ca='public-ca', grpc_tls_secret='grpc-cert',
                      grpc_route_termination='passthrough', runtime_ca_configmap='runtime-ca')
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


if __name__ == '__main__':
    unittest.main()
