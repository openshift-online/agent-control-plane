"""Render operator-approved image Roles and controller bind permissions."""
import hashlib
import re


def valid_name(value, namespace=False):
    pattern = r'[a-z0-9](?:[-a-z0-9]*[a-z0-9])?'
    return (isinstance(value, str) and len(value) <= (63 if namespace else 253)
            and all(re.fullmatch(pattern, part) for part in ([value] if namespace else value.split('.'))))


def image_pull_access(config, controller_namespace):
    if not valid_name(controller_namespace, namespace=True):
        raise ValueError('Image pull delegation requires a valid controller namespace')
    selected = config.get('sandbox_image_pull_roles', [])
    if not isinstance(selected, list) or len(selected) > 32:
        raise ValueError('sandbox_image_pull_roles must be an array with at most 32 roles')
    targets = set()
    for role in selected:
        if (not isinstance(role, dict) or set(role) != {'namespace', 'role'}
                or not valid_name(role['namespace'], namespace=True) or not valid_name(role['role'])):
            raise ValueError('Image pull roles require valid namespace and role names')
        target = (role['namespace'], role['role'])
        if target in targets:
            raise ValueError('Duplicate image pull role')
        targets.add(target)

    definitions = config.get('image_pull_role_definitions', [])
    if not isinstance(definitions, list):
        raise ValueError('image_pull_role_definitions must be an array')
    items = []
    defined = set()
    for definition in definitions:
        if not isinstance(definition, dict) or set(definition) != {'namespace', 'role', 'image_streams'}:
            raise ValueError('Image pull role definitions require namespace, role, and image_streams')
        target = (definition['namespace'], definition['role'])
        streams = definition['image_streams']
        if (not all(isinstance(value, str) for value in target) or target not in targets or target in defined
                or not isinstance(streams, list) or not streams or not all(valid_name(name) for name in streams)
                or len(streams) != len(set(streams))):
            raise ValueError('Image pull role definitions must select unique named image streams for an approved role')
        defined.add(target)
        items.append({'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'Role',
            'metadata': {'namespace': target[0], 'name': target[1]},
            'rules': [{'apiGroups': ['image.openshift.io'], 'resources': ['imagestreams/layers'],
                       'resourceNames': streams, 'verbs': ['get']}]})

    for role in selected:
        suffix = hashlib.sha256((controller_namespace + '\0' + role['namespace'] + '\0' + role['role']).encode()).hexdigest()[:16]
        name = 'hypershell-image-pull-binder-' + suffix
        items.extend([
            {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'Role',
             'metadata': {'namespace': role['namespace'], 'name': name},
             'rules': [{'apiGroups': ['rbac.authorization.k8s.io'], 'resources': ['roles'],
                        'resourceNames': [role['role']], 'verbs': ['get', 'bind']}]},
            {'apiVersion': 'rbac.authorization.k8s.io/v1', 'kind': 'RoleBinding',
             'metadata': {'namespace': role['namespace'], 'name': name},
             'roleRef': {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': name},
             'subjects': [{'kind': 'ServiceAccount', 'name': 'hypershell-controller', 'namespace': controller_namespace}]},
        ])
    return selected, items
