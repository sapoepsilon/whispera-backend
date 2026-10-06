#!/usr/bin/env bash
# Run INSIDE the Debian 13 LXC as root, from a checkout containing deploy/homelab/.
# Installs the release binary, the whispera user, cloudflared and both systemd units.
# Secrets are NOT handled here: run inject-secrets.sh from a Mac with the BWS Touch ID gate.
# Usage: provision-ct.sh /path/to/whispera-server
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
BIN=${1:?path to the built whispera-server binary}
HERE=$(cd "$(dirname "$0")" && pwd)

id whispera >/dev/null 2>&1 || useradd --system --home-dir /var/lib/whispera --shell /usr/sbin/nologin whispera
install -m 0755 "$BIN" /usr/local/bin/whispera-server
install -d -m 0750 -o root -g whispera /etc/whispera
install -d -m 0700 /etc/cloudflared

# cloudflared from Cloudflare's apt repo.
if ! command -v cloudflared >/dev/null; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloudflared
fi

[ -f /etc/whispera/whispera.env ] || install -m 0640 -o root -g whispera "$HERE/whispera.env.template" /etc/whispera/whispera.env
install -m 0644 "$HERE/whispera-server.service" /etc/systemd/system/whispera-server.service
install -m 0644 "$HERE/cloudflared-whispera.service" /etc/systemd/system/cloudflared-whispera.service
systemctl daemon-reload
systemctl enable whispera-server.service cloudflared-whispera.service

# No inbound ports: the service binds 127.0.0.1 and cloudflared only dials out.
systemctl disable --now ssh.service ssh.socket postfix.service 2>/dev/null || true
echo "provisioned; now run inject-secrets.sh, then: systemctl start whispera-server cloudflared-whispera"
