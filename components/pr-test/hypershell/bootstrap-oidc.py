#!/usr/bin/env python3
"""Create dedicated ACP clients in the existing test Keycloak realm."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import urllib.error
import urllib.parse
import urllib.request


def request(url, method='GET', data=None, token=None, form=False):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    body = None
    if data is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
        body = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, body, headers, method=method), timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Keycloak {method} request failed with HTTP {error.code}') from None


def private_write(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(value)
    os.chmod(path, 0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--admin-namespace', default='keycloak')
    parser.add_argument('--admin-deployment', default='keycloak')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    context = os.environ.get('ACP_OC_CONTEXT')
    if not context:
        parser.error('Set ACP_OC_CONTEXT')
    issuer = config['oidc_issuer'].rstrip('/')
    server, realm = issuer.rsplit('/realms/', 1)
    deployment = json.loads(subprocess.check_output(['oc', '--context=' + context, 'get', 'deployment',
        args.admin_deployment, '-n', args.admin_namespace, '-o', 'json'], text=True))
    values = {entry['name']: entry.get('value') for entry in deployment['spec']['template']['spec']['containers'][0]['env']}
    username = values.get('KC_BOOTSTRAP_ADMIN_USERNAME')
    password = values.get('KC_BOOTSTRAP_ADMIN_PASSWORD')
    if not username or not password:
        parser.error('The test Keycloak deployment does not expose bootstrap admin settings')
    token = request(server + '/realms/master/protocol/openid-connect/token', 'POST',
        {'grant_type': 'password', 'client_id': 'admin-cli', 'username': username, 'password': password}, form=True)['access_token']
    admin = server + '/admin/realms/' + urllib.parse.quote(realm)
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(args.output_dir, 0o700)
    ui_url = f'https://ambient-ui-{config["namespace"]}.{config["apps_domain"]}'
    management_client = config.get('hypershell_client_id', config['namespace'] + '-manager')
    clients = [(config['cp_client_id'], 'cp-client-secret', False),
               (config['ui_client_id'], 'ui-client-secret', True),
               (management_client, 'hypershell-client-secret', False)]
    for client_id, filename, browser in clients:
        found = request(admin + '/clients?' + urllib.parse.urlencode({'clientId': client_id}), token=token)
        existing = next((item for item in found if item['clientId'] == client_id), None)
        client = dict(existing or {})
        client.update({'clientId': client_id, 'name': 'ACP Hypershell test: ' + client_id,
            'enabled': True, 'protocol': 'openid-connect', 'publicClient': False,
            'serviceAccountsEnabled': not browser, 'standardFlowEnabled': browser,
            'directAccessGrantsEnabled': False, 'fullScopeAllowed': True,
            'defaultClientScopes': ['email', 'profile', 'roles']})
        if browser:
            client.update({'redirectUris': [ui_url + '/api/auth/sso/callback'], 'webOrigins': [ui_url],
                'attributes': {'post.logout.redirect.uris': ui_url + '/*', 'pkce.code.challenge.method': 'S256'}})
            client['protocolMappers'] = [{'name': 'acp-audience', 'protocol': 'openid-connect',
                'protocolMapper': 'oidc-audience-mapper', 'config': {'included.client.audience': client_id,
                'id.token.claim': 'false', 'access.token.claim': 'true'}}]
        if existing:
            request(admin + '/clients/' + existing['id'], 'PUT', client, token)
            client_uuid = existing['id']
        else:
            client['secret'] = secrets.token_urlsafe(40)
            request(admin + '/clients', 'POST', client, token)
            client_uuid = request(admin + '/clients?' + urllib.parse.urlencode({'clientId': client_id}), token=token)[0]['id']
        secret_value = request(admin + '/clients/' + client_uuid + '/client-secret', token=token)['value']
        private_write(args.output_dir / filename, secret_value)
        if client_id == management_client:
            user = request(admin + '/clients/' + client_uuid + '/service-account-user', token=token)
            role = request(admin + '/roles/' + urllib.parse.quote('gateway:creator'), token=token)
            request(admin + '/users/' + user['id'] + '/role-mappings/realm', 'POST', [role], token)
        print('OIDC client is ready: ' + client_id)
    private_write(args.output_dir / 'oidc.json', json.dumps({'issuer': issuer,
        'token_url': issuer + '/protocol/openid-connect/token', 'cp_client_id': config['cp_client_id'],
        'ui_client_id': config['ui_client_id'], 'hypershell_client_id': management_client}, indent=2))
    print('Client secrets are stored in ' + str(args.output_dir))


if __name__ == '__main__':
    main()
