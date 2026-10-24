#!/usr/bin/env bash
# Live proof in a throwaway Linux sandbox (we ran it in Daytona via drun).
# Installs PostgreSQL and Odoo Community from source (branch $1, e.g. 18.0),
# builds the npm tarball, installs it in an empty project, and runs
# proof/live-proof.mjs against the installed `odoo-mcp` bin over stdio.
set -euo pipefail
BRANCH="${1:?usage: run-live.sh 17.0|18.0|19.0}"
case "$BRANCH" in 17.0) PY=3.11 ;; *) PY=3.12 ;; esac
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/proof/odoo-${BRANCH%%.*}"
mkdir -p "$OUT"
exec > >(tee "$OUT/run.log") 2>&1
export DEBIAN_FRONTEND=noninteractive
echo "== $(date -u +%FT%TZ) Odoo $BRANCH, Python $PY, $(node -v)"

sudo -E apt-get -qq update
sudo -E apt-get -qq install -y postgresql libpq-dev libldap2-dev libsasl2-dev libxml2-dev libxslt1-dev libjpeg-dev zlib1g-dev build-essential git curl >/dev/null
command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null; export PATH="$HOME/.local/bin:$PATH"; }
PGV=$(ls /usr/lib/postgresql | sort -n | tail -1)
sudo pg_ctlcluster "$PGV" main start || true
sudo -u postgres createuser --superuser "$(whoami)" 2>/dev/null || true
echo "== PostgreSQL $PGV"

git clone -q --depth 1 --branch "$BRANCH" https://github.com/odoo/odoo.git /tmp/odoo
echo "== odoo commit $(git -C /tmp/odoo rev-parse HEAD)"
uv venv -q --python "$PY" /tmp/odoo-venv
uv pip install -q --python /tmp/odoo-venv/bin/python -r /tmp/odoo/requirements.txt
ODOO_BIN="/tmp/odoo-venv/bin/python /tmp/odoo/odoo-bin"
ODOO_ARGS="--addons-path=/tmp/odoo/addons,/tmp/odoo/odoo/addons -d mcp_proof --db_host=/var/run/postgresql"
ODOO="$ODOO_BIN $ODOO_ARGS"
DEMO="--without-demo=all"; [ "$BRANCH" = "19.0" ] && DEMO=""
createdb mcp_proof
$ODOO $DEMO -i sale_management,purchase,mrp,stock --stop-after-init --log-level=warn
echo "== modules installed"

# An API key for the admin user, so the MCP server authenticates with a key, not the password.
KEYFILE=/tmp/odoo-apikey
$ODOO_BIN shell $ODOO_ARGS --no-http --log-level=warn >/tmp/odoo-shell.log 2>&1 <<'PY' || { echo "API key generation failed; the proof falls back to the password"; grep -v "^$" /tmp/odoo-shell.log | tail -5; }
import inspect, datetime
Keys = env['res.users.apikeys'].with_user(env.ref('base.user_admin'))
params = inspect.signature(Keys._generate).parameters
key = Keys._generate(None, 'odoo-mcp live proof', datetime.datetime.now() + datetime.timedelta(days=1)) if 'expiration_date' in params else Keys._generate(None, 'odoo-mcp live proof')
_ = open('/tmp/odoo-apikey', 'w').write(key)
env.cr.commit()
PY
[ -s "$KEYFILE" ] && echo "== API key created for admin (value not logged)"

$ODOO --http-port=8069 --workers=0 --log-level=warn >/tmp/odoo-server.log 2>&1 &
ODOO_PID=$!
trap 'kill $ODOO_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do curl -fsS -o /dev/null http://127.0.0.1:8069/web/login && break; sleep 2; done
echo "== Odoo HTTP up"

cd "$REPO"
npm ci --no-audit --no-fund >/dev/null
TARBALL="$(npm pack --silent)"
echo "== packed $TARBALL ($(du -h "$TARBALL" | cut -f1))"
mkdir -p /tmp/consumer && cd /tmp/consumer && npm init -y >/dev/null && npm install --no-audit --no-fund "$REPO/$TARBALL" >/dev/null
echo "== installed $(node -p "require('./node_modules/@helios-one/odoo-mcp/package.json').name + '@' + require('./node_modules/@helios-one/odoo-mcp/package.json').version") into an empty project"
cd "$REPO"

export ODOO_URL=http://127.0.0.1:8069 ODOO_DB=mcp_proof ODOO_USERNAME=admin ODOO_PASSWORD=admin ODOO_API_KEY_FILE=$KEYFILE
set +e
node proof/live-proof.mjs /tmp/consumer "$OUT/session.json"
STATUS=$?
set -e

echo "== MCP Inspector CLI against the same installed bin"
npx -y @modelcontextprotocol/inspector@latest --cli /tmp/consumer/node_modules/.bin/odoo-mcp \
  -e ODOO_URL=$ODOO_URL -e ODOO_DB=$ODOO_DB -e ODOO_USERNAME=admin -e ODOO_PASSWORD=admin \
  --method tools/call --tool-name lookup_supplier --tool-arg query=Proof > "$OUT/inspector-lookup_supplier.json" 2>&1 \
  && echo "inspector tools/call ok: $(grep -c 'Proof Steel Supplier' "$OUT/inspector-lookup_supplier.json") match(es)" \
  || echo "inspector run failed (see inspector-lookup_supplier.json)"
grep -iE "error|traceback" /tmp/odoo-server.log | grep -v "Access Denied\|Login failed" | tail -5 || true
echo "== live proof exit $STATUS"
rm -f "$REPO/$TARBALL"
exit $STATUS
