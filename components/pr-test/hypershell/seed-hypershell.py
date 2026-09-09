#!/usr/bin/env python3
"""Create the dedicated cluster and image release for ACP gateways."""
import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('config', type=Path)
parser.add_argument('--credentials-dir', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
config = json.loads(args.config.read_text())
oidc = json.loads((args.credentials_dir / 'oidc.json').read_text())
body = urllib.parse.urlencode({'grant_type': 'client_credentials',
    'client_id': oidc['hypershell_client_id'],
    'client_secret': (args.credentials_dir / 'hypershell-client-secret').read_text()}).encode()
with urllib.request.urlopen(urllib.request.Request(oidc['token_url'], body), timeout=30) as response:
    token = json.load(response)['access_token']
base = config['api_url'].rstrip('/') + '/api/hypershell/v1'


def request(path, data=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path,
                json.dumps(data).encode() if data else None,
                {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}), timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Hypershell request failed with HTTP {error.code}') from None


def ensure(resource, desired):
    entries = []
    page = 1
    while True:
        result = request(f'/{resource}?page={page}&size=100')
        entries.extend(result['items'])
        if len(entries) >= result['total']:
            break
        if not result['items']:
            raise RuntimeError('Hypershell returned an incomplete resource list')
        page += 1
    matches = [item for item in entries if item['name'] == desired['name']]
    if len(matches) > 1:
        raise RuntimeError('Duplicate Hypershell resource name: ' + desired['name'])
    if matches:
        for key, value in desired.items():
            if matches[0].get(key) != value:
                raise RuntimeError('Existing Hypershell resource differs: ' + desired['name'])
        return matches[0]['id']
    return request('/' + resource, desired)['id']


cluster_id = ensure('managed_clusters', {'name': config['cluster_name'], 'provider': 'openshift',
    'region': config['region'], 'kubeconfig_secret': config['kubeconfig_secret']})
release_id = ensure('gateway_releases', {'name': config['release_name'], 'image': config['gateway_image']})
template = {'cluster_id': cluster_id, 'release_id': release_id, 'image': config['gateway_image'],
    'supervisor_image': config['supervisor_image'], 'route': json.dumps({'enabled': True}),
    'credential_driver': json.dumps({'type': 'kubernetes-secrets'})}
args.output.parent.mkdir(parents=True, exist_ok=True)
with os.fdopen(os.open(args.output, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600), 'w') as stream:
    json.dump(template, stream, indent=2)
print('Managed cluster: ' + cluster_id)
print('Gateway release: ' + release_id)
print('Gateway template: ' + str(args.output))
