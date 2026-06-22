#!/bin/bash
# Validate OpenShift templates

set -e

echo "Validating OpenShift templates..."

cd "$(dirname "$0")"

for template in template-services.yaml; do
  echo "  Checking $template..."
  oc process -f "$template" \
    --param=IMAGE_TAG=validation-test \
    --param=KEYCLOAK_REALM_URL=https://keycloak.example.com/realms/ambient-code \
    --local > /dev/null
  echo "    ✓ Valid"
done

echo "✓ All templates valid"
