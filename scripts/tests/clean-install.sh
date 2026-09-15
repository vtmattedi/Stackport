#!/usr/bin/env bash
# Run only inside the disposable Docker-in-Docker container from test-clean-install.ps1.
set -euo pipefail
[[ "${STACKPORT_REGRESSION:-}" == 1 && -f /fixture/stackport.sh ]] || { echo 'Use scripts/test-clean-install.ps1'; exit 1; }
apk add --no-cache bash curl git openssl coreutils >/dev/null
for i in {1..30}; do docker info >/dev/null 2>&1 && break; sleep 1; done
docker load -i /image.tar >/dev/null
rm /image.tar
git config --global user.email regression@example.test
git config --global user.name Regression
printf 'FROM stackport-regression:local\n' > /fixture/Dockerfile
git -C /fixture init -b main >/dev/null
git -C /fixture add .
git -C /fixture commit -qm fixture
mkdir -p /fake-certbot
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Stackport-Test-CA -keyout /fake-certbot/ca.key -out /fake-certbot/ca.crt >/dev/null 2>&1
export CURL_CA_BUNDLE=/fake-certbot/ca.crt
cat > /fake-certbot/Dockerfile <<'EOF'
FROM alpine:3.22
RUN apk add --no-cache openssl curl
COPY . /test
ENTRYPOINT ["sh", "/test/certbot.sh"]
EOF
# This substitutes the CA only. Real containers, root-only certificate directories,
# challenge files, HTTP routes, HTTPS, app DB and installer lifecycle are exercised.
cat > /fake-certbot/certbot.sh <<'EOF'
set -eu
[ "${1:-}" != --version ] || { echo 'certbot regression'; exit 0; }
if [ -f /etc/letsencrypt/fail-once ]; then rm /etc/letsencrypt/fail-once; echo 'simulated CA outage' >&2; exit 1; fi
domains=''; webroot=''
while [ $# -gt 0 ]; do
  case "$1" in -d) domains="$domains $2"; shift;; -w) webroot="$2"; shift;; esac
  shift
done
set -- $domains
domain="$1"
mkdir -p "$webroot/.well-known/acme-challenge"
echo verified > "$webroot/.well-known/acme-challenge/regression"
gateway=$(ip route | awk '/default/ {print $3}')
san=''
for name in $domains; do
  test "$(curl -fsS -H "Host: $name" "http://$gateway/.well-known/acme-challenge/regression")" = verified
  san="${san:+$san,}DNS:$name"
done
mkdir -p "/etc/letsencrypt/archive/$domain" "/etc/letsencrypt/live/$domain"
chmod 700 /etc/letsencrypt/live /etc/letsencrypt/archive
openssl req -newkey rsa:2048 -nodes -subj "/CN=$domain" -keyout "/etc/letsencrypt/archive/$domain/privkey1.pem" -out /tmp/request >/dev/null 2>&1
printf 'subjectAltName=%s\n' "$san" > /tmp/extensions
openssl x509 -req -in /tmp/request -CA /test/ca.crt -CAkey /test/ca.key -CAcreateserial -days 1 -extfile /tmp/extensions -out "/etc/letsencrypt/archive/$domain/fullchain1.pem" >/dev/null 2>&1
chmod 600 "/etc/letsencrypt/archive/$domain/privkey1.pem"
ln -sf "../../archive/$domain/fullchain1.pem" "/etc/letsencrypt/live/$domain/fullchain.pem"
ln -sf "../../archive/$domain/privkey1.pem" "/etc/letsencrypt/live/$domain/privkey.pem"
EOF
docker build -q -t certbot/certbot /fake-certbot >/dev/null
export STACKPORT_REPO=/fixture STACKPORT_INGRESS_ATTEMPTS=15
bash -n /fixture/stackport.sh
mkdir -p /etc/letsencrypt
touch /etc/letsencrypt/fail-once
if bash /fixture/stackport.sh install --domain=sp.install.test --email=regression@example.test --yes > /first-install.log 2>&1; then
  echo 'FAIL: installer accepted failed HTTPS'; exit 1
fi
grep -q 'HTTPS is not ready' /first-install.log
secrets_before=$(sha256sum /etc/stackport/secrets.env | cut -d' ' -f1)
bash /fixture/stackport.sh install --yes > /retry-install.log 2>&1
test "$secrets_before" = "$(sha256sum /etc/stackport/secrets.env | cut -d' ' -f1)"
curl -fsS --resolve sp.install.test:443:127.0.0.1 https://sp.install.test/health >/dev/null
echo 'PASS: failed HTTPS blocks install; rerun retries setup without changing secrets'
docker exec --user node -w /app stackport node -e 'const assert=require("assert"); require("./dist/config/database").initializeDatabase(); const n=require("./dist/services/nginx/configWriter"); assert.equal(n.getNginxRuntime(),"container"); assert.equal(n.getNginxAppConfig().useSsl,true); require("./dist/services/certbot").getCertbotStatus().then(s=>{assert(s.available);assert(s.emailConfigured);assert(s.entries.find(e=>e.domain==="sp.install.test").hasCertificate);console.log("PASS: container status and certificate detection work as node")}).catch(e=>{console.error(e);process.exit(1)});'
mkdir -p /var/lib/stackport/data/repos/1-regression
cat > /var/lib/stackport/data/repos/1-regression/compose.yml <<'EOF'
services:
  web:
    image: nginx:1.27-alpine
    expose: ["80"]
EOF
docker compose -p 1-regression -f /var/lib/stackport/data/repos/1-regression/compose.yml up -d >/dev/null
chown -R 1000:1000 /var/lib/stackport/data/repos
docker exec --user node -w /app stackport node /app/scripts/tests/project-regressions.cjs
curl --retry 10 --retry-all-errors --retry-delay 1 -fsS --resolve site.install.test:443:127.0.0.1 https://site.install.test/ >/dev/null
curl -fsS -H 'Host: site.install.test' http://127.0.0.1/.well-known/acme-challenge/regression | grep -q verified
curl -fsS -H 'Host: www.site.install.test' http://127.0.0.1/.well-known/acme-challenge/regression | grep -q verified
docker restart stackport >/dev/null
sleep 5
curl -fsS --resolve sp.install.test:443:127.0.0.1 https://sp.install.test/health >/dev/null
echo 'PASS: project HTTPS and renewal challenges; Stackport HTTPS survives restart'
docker compose -p 1-regression -f /var/lib/stackport/data/repos/1-regression/compose.yml stop web >/dev/null
docker restart stackport-nginx >/dev/null
curl --retry 15 --retry-all-errors --retry-delay 1 -fsS --resolve sp.install.test:443:127.0.0.1 https://sp.install.test/health >/dev/null
echo 'PASS: stopped workload cannot block nginx startup or admin HTTPS'
sed -i '/container_name: stackport-nginx/a\    environment:\n      - STACKPORT_TEST_MARKER=updated' /fixture/docker-compose.system.yml
git -C /fixture add docker-compose.system.yml
git -C /fixture commit -qm 'system nginx change'
stackport update > /update.log 2>&1
docker inspect stackport-nginx --format '{{json .Config.Env}}' | grep -q STACKPORT_TEST_MARKER=updated
stackport rollback > /rollback.log 2>&1
if docker inspect stackport-nginx --format '{{json .Config.Env}}' | grep -q STACKPORT_TEST_MARKER=updated; then
  echo 'FAIL: rollback did not reconcile nginx'; exit 1
fi
curl --retry 15 --retry-all-errors --retry-delay 1 -fsS --resolve sp.install.test:443:127.0.0.1 https://sp.install.test/health >/dev/null
echo 'PASS: CLI update and rollback reconcile nginx configuration and preserve HTTPS'
echo 'All clean-install regressions passed (test CA; no public ACME requests).'
