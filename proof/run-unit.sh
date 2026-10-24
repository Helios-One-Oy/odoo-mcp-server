#!/usr/bin/env bash
# Unit + stdio tests on the sandbox's Node and on Node 20 (the minimum in package.json engines).
set -uo pipefail
cd "$(dirname "$0")/.."
exec > >(tee proof/unit-tests.log) 2>&1
echo "== $(date -u +%FT%TZ) node $(node -v)"
npm ci --no-audit --no-fund --loglevel=error
timeout 300 npm test; A=$?
echo "== node 20: $(npx -y -p node@20 node -v)"
timeout 300 npx -y -p node@20 node --test --test-timeout=30000 test/*.test.js; B=$?
echo "== exit node-current=$A node20=$B"
exit $(( A || B ))
