#!/usr/bin/env python3
"""Reconcile ACP Secrets without printing secret values."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('--cp-client-secret-file', required=True, type=Path)
    parser.add_argument('--ui-client-secret-file', required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    context = os.environ.get('ACP_OC_CONTEXT')
    if not context:
        parser.error('Set ACP_OC_CONTEXT to the target cluster context')
    cli = ['oc', f'--context={context}', '-n', config['namespace']]

    def get(name):
        result = subprocess.run(cli + ['get', 'secret', name, '--ignore-not-found', '-o', 'json'],
                                check=True, capture_output=True, text=True)
        if not result.stdout.strip():
            return {}
        data = json.loads(result.stdout).get('data', {})
        return {key: base64.b64decode(value).decode() for key, value in data.items()}

    def apply(name, values):
        obj = {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {
            'name': name, 'namespace': config['namespace'],
            'labels': {'app.kubernetes.io/part-of': 'acp-hypershell'}},
            'type': 'Opaque', 'stringData': values}
        # Server-side apply does not copy Secret data into a last-applied annotation.
        result = subprocess.run(cli + ['apply', '--server-side', '--field-manager=acp-hypershell', '-f', '-'],
                                input=json.dumps(obj), capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f'Cannot apply Secret {name}; inspect cluster permissions and field ownership')
        print(f'Secret {name} is ready')

    pair = get('ambient-cp-token-keypair')
    if pair and (not pair.get('private.pem') or not pair.get('public.pem')):
        raise RuntimeError('Runner keypair Secret is incomplete; repair it before deployment')
    if not pair:
        private_key = subprocess.check_output(['openssl', 'genrsa', '-traditional', '4096'], stderr=subprocess.DEVNULL)
        public_key = subprocess.check_output(['openssl', 'rsa', '-pubout'], input=private_key, stderr=subprocess.DEVNULL)
        apply('ambient-cp-token-keypair', {'private.pem': private_key.decode(), 'public.pem': public_key.decode()})

    cp_secret = args.cp_client_secret_file.read_text().strip()
    ui_secret = args.ui_client_secret_file.read_text().strip()
    if not cp_secret or not ui_secret:
        parser.error('OIDC client secret files must not be empty')
    db = get('ambient-api-server-db')
    apply('ambient-api-server-db', {'db.host': 'ambient-api-server-db', 'db.port': '5432',
        'db.name': 'ambient_api_server', 'db.user': 'ambient',
        'db.password': db.get('db.password') or secrets.token_urlsafe(32)})
    key = get('credential-encryption-key')
    if bool(key.get('keyring')) != bool(key.get('version')):
        raise RuntimeError('Credential encryption Secret is incomplete; repair it before deployment')
    apply('credential-encryption-key', key or {'keyring': json.dumps({
        '1': base64.b64encode(secrets.token_bytes(32)).decode()}), 'version': '1'})
    sso = get('sso-credentials')
    apply('sso-credentials', {'SSO_CLIENT_SECRET': ui_secret,
        'SESSION_SECRET': sso.get('SESSION_SECRET') or secrets.token_urlsafe(32)})
    apply('ambient-control-plane-oidc', {'client-id': config['cp_client_id'], 'client-secret': cp_secret})
    apply('ambient-api-server', {'clientId': config['cp_client_id'], 'clientSecret': cp_secret})


if __name__ == '__main__':
    main()
