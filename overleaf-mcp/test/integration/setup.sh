#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
docker compose up -d

echo "Waiting for sharelatex to come up..."
for i in $(seq 1 60); do
  if curl -fsS http://localhost:8080/login >/dev/null 2>&1; then
    echo "  ready after ${i} attempts"
    break
  fi
  sleep 2
done

# Initialize MongoDB replica set (CE 5.x requires this)
docker compose exec -T mongo mongosh --quiet --eval 'try { rs.initiate({_id: "overleaf", members: [{_id: 0, host: "mongo:27017"}]}) } catch(e) { print(e) }' || true
sleep 5

# Create a regular user. The activation URL will be printed to stdout; capture it.
docker compose exec -T sharelatex /sbin/setuser sharelatex /bin/bash -c \
  'cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user --email=user@test.local --admin=false' \
  || true

# Note: if the activation flow proves too painful, switch to driving setup
# through the public REST endpoints (register/forgot-password).

echo "If the script above printed an activation URL, follow it once in a browser to set the password."
echo "Then run:"
echo "  TEST_OVERLEAF_PASSWORD=<your-password> npm run test:integration"
