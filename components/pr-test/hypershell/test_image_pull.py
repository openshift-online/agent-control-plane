"""Check exact image pull grants and narrow controller delegation."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from image_pull import image_pull_access


class ImagePullTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            'sandbox_image_pull_roles': [{'namespace': 'images', 'role': 'runner-pull'}],
            'image_pull_role_definitions': [{'namespace': 'images', 'role': 'runner-pull', 'image_streams': ['runner']}],
        }

    def test_only_selected_image_and_controller_receive_permissions(self):
        roles, items = image_pull_access(self.config, 'hypershell-test')
        self.assertEqual(roles, self.config['sandbox_image_pull_roles'])
        pull = next(item for item in items if item['metadata']['name'] == 'runner-pull')
        self.assertEqual(pull['rules'], [{'apiGroups': ['image.openshift.io'], 'resources': ['imagestreams/layers'],
                                         'resourceNames': ['runner'], 'verbs': ['get']}])
        binder = next(item for item in items if item['kind'] == 'Role' and item != pull)
        self.assertEqual(binder['rules'], [{'apiGroups': ['rbac.authorization.k8s.io'], 'resources': ['roles'],
                                          'resourceNames': ['runner-pull'], 'verbs': ['get', 'bind']}])
        binding = next(item for item in items if item['kind'] == 'RoleBinding')
        self.assertEqual(binding['subjects'], [{'kind': 'ServiceAccount', 'name': 'hypershell-controller',
                                               'namespace': 'hypershell-test'}])
        self.assertEqual(binding['metadata']['namespace'], 'images')
        self.assertEqual(binding['roleRef']['name'], binder['metadata']['name'])
        self.assertEqual(image_pull_access(self.config, 'hypershell-test'), (roles, items))
        _, other = image_pull_access(self.config, 'other-controller')
        self.assertNotEqual(other[-1]['metadata']['name'], binding['metadata']['name'])

    def test_existing_role_needs_no_definition_and_default_grants_nothing(self):
        self.config.pop('image_pull_role_definitions')
        _, items = image_pull_access(self.config, 'hypershell-test')
        self.assertEqual(len(items), 2)
        self.assertEqual(image_pull_access({}, 'hypershell-test'), ([], []))

    def test_invalid_or_unselected_roles_are_rejected(self):
        for key, value in [
            ('sandbox_image_pull_roles', [{'namespace': 'images', 'role': '*'}]),
            ('sandbox_image_pull_roles', [{'namespace': '*', 'role': 'runner-pull'}]),
            ('sandbox_image_pull_roles', self.config['sandbox_image_pull_roles'] * 2),
            ('image_pull_role_definitions', [{'namespace': 'images', 'role': 'not-selected', 'image_streams': ['runner']}]),
            ('image_pull_role_definitions', [{'namespace': 'images', 'role': 'runner-pull', 'image_streams': ['*']}]),
        ]:
            with self.subTest(key=key, value=value):
                config = copy.deepcopy(self.config)
                config[key] = value
                with self.assertRaises(ValueError):
                    image_pull_access(config, 'hypershell-test')

    def test_example_config_has_complete_image_pull_setup(self):
        config = json.loads(Path(__file__).with_name('hypershell-config.example.json').read_text())
        selected, items = image_pull_access(config, config['namespace'])
        self.assertEqual(selected, [{'namespace': 'acp-hypershell', 'role': 'acp-runner-image-pull'}])
        self.assertEqual(len(items), 3)

    def test_controller_receives_only_namespace_role_selections(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            base = source / 'deploy/base'
            (base / 'certificates').mkdir(parents=True)
            for name in ('api-server.yaml', 'controller-rbac.yaml', 'postgres.yaml',
                         'certificates/ca-chain.yaml', 'networkpolicies.yaml'):
                (base / name).write_text('')
            (base / 'controller.yaml').write_text(json.dumps({'apiVersion': 'apps/v1', 'kind': 'Deployment',
                'metadata': {'name': 'hypershell-controller', 'namespace': 'original'},
                'spec': {'template': {'spec': {'containers': [{'name': 'controller', 'env': []}]}}}}))
            config = dict(self.config, namespace='hypershell-test', oidc_issuer='https://issuer.example',
                          controller_image='example/controller:test', cp_client_id='controller',
                          storage_class='storage', apps_domain='apps.example')
            path = source / 'config.json'
            path.write_text(json.dumps(config))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('render-hypershell.py')),
                str(source), str(path)], check=True, capture_output=True, text=True)
            items = json.loads(result.stdout)['items']
        controller = next(item for item in items if item['kind'] == 'Deployment')
        env = {entry['name']: entry.get('value') for entry in controller['spec']['template']['spec']['containers'][0]['env']}
        self.assertEqual(json.loads(env['GATEWAY_SANDBOX_IMAGE_PULL_ROLES']), self.config['sandbox_image_pull_roles'])
        self.assertEqual(len([item for item in items if item['kind'] == 'Role']), 2)
        self.assertEqual(len([item for item in items if item['kind'] == 'RoleBinding']), 1)


if __name__ == '__main__':
    unittest.main()
