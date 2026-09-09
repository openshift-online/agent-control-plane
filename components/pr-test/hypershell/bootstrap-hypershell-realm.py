#!/usr/bin/env python3
"""Create a separate realm for one Hypershell test installation."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import urllib.parse

from importlib.util import module_from_spec, spec_from_file_location


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('--realm', required=True)
    parser.add_argument('--instance-id', required=True)
    parser.add_argument('--manager-client-id', required=True)
    parser.add_argument('--provisioner-client-id', required=True)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    context = os.environ.get('ACP_OC_CONTEXT')
    if not context:
        parser.error('Set ACP_OC_CONTEXT')
    config = json.loads(args.config.read_text())
    server, _ = config['oidc_issuer'].rstrip('/').rsplit('/realms/', 1)
    if args.realm == 'master' or not args.realm.replace('-', '').isalnum():
        parser.error('Use a realm name with letters, digits, or hyphens, other than master')
    spec = spec_from_file_location('bootstrap_oidc', Path(__file__).with_name('bootstrap-oidc.py'))
    helper = module_from_spec(spec)
    spec.loader.exec_module(helper)
    request, private_write = helper.request, helper.private_write
    oc = ['oc', '--context=' + context]
    deployment = json.loads(subprocess.check_output(oc + ['get', 'deployment', 'keycloak', '-n', 'keycloak', '-o', 'json'], text=True))
    values = {}
    for entry in deployment['spec']['template']['spec']['containers'][0]['env']:
        if entry['name'] not in ('KC_BOOTSTRAP_ADMIN_USERNAME', 'KC_BOOTSTRAP_ADMIN_PASSWORD'):
            continue
        if 'value' in entry:
            values[entry['name']] = entry['value']
        else:
            ref = entry['valueFrom']['secretKeyRef']
            secret = json.loads(subprocess.check_output(oc + ['get', 'secret', ref['name'], '-n', 'keycloak', '-o', 'json'], text=True))
            values[entry['name']] = base64.b64decode(secret['data'][ref['key']]).decode()
    token = request(server + '/realms/master/protocol/openid-connect/token', 'POST', {
        'grant_type': 'password', 'client_id': 'admin-cli',
        'username': values['KC_BOOTSTRAP_ADMIN_USERNAME'], 'password': values['KC_BOOTSTRAP_ADMIN_PASSWORD']}, form=True)['access_token']
    realm_url = server + '/admin/realms/' + urllib.parse.quote(args.realm)
    existing = next((r for r in request(server + '/admin/realms', token=token) if r['realm'] == args.realm), None)
    owner_key = 'acp.hypershell.instance'
    if existing:
        existing = request(realm_url, token=token)
        if existing.get('attributes', {}).get(owner_key) != args.instance_id:
            parser.error('The realm is not owned by this test installation')
    else:
        request(server + '/admin/realms', 'POST', {'realm': args.realm, 'enabled': True,
            'sslRequired': 'external', 'registrationAllowed': False, 'accessTokenLifespan': 300,
            'attributes': {owner_key: args.instance_id}}, token)
    for role in ('hypershell-admins', 'hypershell-users', 'gateway:creator', 'platform:admin'):
        roles = request(realm_url + '/roles', token=token)
        if not any(r['name'] == role for r in roles):
            request(realm_url + '/roles', 'POST', {'name': role}, token)
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(args.output_dir, 0o700)
    issuer = server + '/realms/' + args.realm
    clients = [(config['cp_client_id'], 'service-client-secret'),
               (args.manager_client_id, 'manager-client-secret'),
               (args.provisioner_client_id, 'provisioner-client-secret')]
    client_ids = {}
    for client_id, filename in clients:
        found = request(realm_url + '/clients?' + urllib.parse.urlencode({'clientId': client_id}), token=token)
        client = next((c for c in found if c['clientId'] == client_id), None)
        desired = {'clientId': client_id, 'name': 'ACP isolated Hypershell: ' + client_id,
            'enabled': True, 'protocol': 'openid-connect', 'publicClient': False,
            'serviceAccountsEnabled': True, 'standardFlowEnabled': False,
            'directAccessGrantsEnabled': False, 'fullScopeAllowed': True,
            'defaultClientScopes': ['email', 'profile', 'roles'],
            'attributes': {'access.token.lifespan': '300'},
            'protocolMappers': [{'name': 'hypershell-api-audience', 'protocol': 'openid-connect',
                'protocolMapper': 'oidc-audience-mapper', 'config': {
                    'included.client.audience': config['cp_client_id'],
                    'id.token.claim': 'false', 'access.token.claim': 'true'}}]}
        if client:
            request(realm_url + '/clients/' + client['id'], 'PUT', desired, token)
        else:
            desired['secret'] = secrets.token_urlsafe(40)
            request(realm_url + '/clients', 'POST', desired, token)
            client = request(realm_url + '/clients?' + urllib.parse.urlencode({'clientId': client_id}), token=token)[0]
        client_ids[client_id] = client['id']
        secret_value = request(realm_url + '/clients/' + client['id'] + '/client-secret', token=token)['value']
        private_write(args.output_dir / filename, secret_value)
        user = request(realm_url + '/clients/' + client['id'] + '/service-account-user', token=token)
        roles = ['gateway:creator', 'hypershell-users'] if client_id == args.manager_client_id else ['hypershell-users']
        mappings = [request(realm_url + '/roles/' + urllib.parse.quote(role), token=token) for role in roles]
        request(realm_url + '/users/' + user['id'] + '/role-mappings/realm', 'POST', mappings, token)
        if client_id == args.provisioner_client_id:
            management = request(realm_url + '/clients?clientId=realm-management', token=token)[0]
            roles_url = realm_url + '/clients/' + management['id'] + '/roles/'
            mappings = [request(roles_url + role, token=token) for role in ('manage-clients', 'manage-users')]
            request(realm_url + '/users/' + user['id'] + '/role-mappings/clients/' + management['id'], 'POST', mappings, token)
        access = request(issuer + '/protocol/openid-connect/token', 'POST', {
            'grant_type': 'client_credentials', 'client_id': client_id, 'client_secret': secret_value}, form=True)['access_token']
        payload = access.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        if claims.get('iss') != issuer or claims.get('preferred_username') != 'service-account-' + client_id:
            raise RuntimeError('The new realm did not issue the expected machine identity')
        if client_id == args.provisioner_client_id:
            request(realm_url + '/clients?clientId=' + urllib.parse.quote(config['cp_client_id']), token=access)
        print('Verified isolated realm client: ' + client_id)
    private_write(args.output_dir / 'realm.json', json.dumps({'issuer': issuer, 'realm': args.realm,
        'server_url': server, 'service_client_id': config['cp_client_id'],
        'manager_client_id': args.manager_client_id, 'provisioner_client_id': args.provisioner_client_id,
        'client_ids': client_ids}, indent=2))
    print('Isolated realm is ready. Secrets are in ' + str(args.output_dir))


if __name__ == '__main__':
    main()
