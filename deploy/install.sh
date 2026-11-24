#!/usr/bin/env bash
# Install (or update) Budgify on an Ubuntu/Debian server so it runs 24/7,
# reachable only from your own devices through Tailscale.
#
#   git clone https://github.com/BJGajjar669/Budgeting-Tool.git budgify
#   cd budgify && sudo ./deploy/install.sh
#
# Re-run the same command after `git pull` to update. Your data and settings are kept.
#
# What it does:
#   - installs Node.js 22 (if needed) and the app into /opt/budgify
#   - keeps your data in /var/lib/budgify and settings in /etc/budgify/budgify.env
#   - runs Budgify as a locked-down systemd service that restarts on crash/reboot,
#     listening on 127.0.0.1 only (never on a public port)
#   - takes a nightly database backup (last 14 days kept)
#   - installs Tailscale and publishes Budgify at https://<this-server>.<tailnet>.ts.net,
#     visible only to devices signed in to your Tailscale account
#
# Options (environment variables):
#   BUDGIFY_PORT=3000          local port
#   BUDGIFY_SKIP_TAILSCALE=1   don't install/configure Tailscale (bring your own HTTPS proxy)
#   BUDGIFY_SKIP_SYSTEMD=1     install files only (for containers / testing)
set -euo pipefail

APP_DIR=/opt/budgify
DATA_DIR=/var/lib/budgify
CONF_DIR=/etc/budgify
ENV_FILE=$CONF_DIR/budgify.env
SVC_USER=budgify
PORT=${BUDGIFY_PORT:-3000}
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Please run with sudo: sudo ./deploy/install.sh"; exit 1; }
[[ -f $SRC_DIR/src/server.js ]] || { echo "Run this from inside the Budgify folder."; exit 1; }
command -v apt-get >/dev/null || { echo "This installer supports Ubuntu/Debian (apt) servers."; exit 1; }

# --- packages -------------------------------------------------------------------
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
# A fresh server runs automatic security updates for its first few minutes; wait for them
# instead of failing with "Could not get lock /var/lib/dpkg/lock-frontend".
APT_WAIT=(-o DPkg::Lock::Timeout=900)
# Same wait for apt runs inside the Node.js and Tailscale install scripts.
echo 'DPkg::Lock::Timeout "900";' >/etc/apt/apt.conf.d/90budgify-lock-timeout
echo "(If the server is still running its first automatic updates, this waits for them to finish.)"
apt-get "${APT_WAIT[@]}" update -qq
apt-get "${APT_WAIT[@]}" install -y -qq ca-certificates curl gnupg rsync >/dev/null

node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if ! node_ok; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get "${APT_WAIT[@]}" install -y -qq nodejs >/dev/null
fi
node_ok || { echo "Node.js 22.13+ is required but $(node -v 2>/dev/null || echo none) is installed."; exit 1; }
echo "Node $(node -v)"

# --- user, folders, code ----------------------------------------------------------
say "Installing Budgify into $APP_DIR"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
install -d -o root -g root -m 755 "$APP_DIR"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 700 "$DATA_DIR"
install -d -o root -g "$SVC_USER" -m 750 "$CONF_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .env --exclude .git "$SRC_DIR"/ "$APP_DIR"/
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$APP_DIR"

# --- settings -------------------------------------------------------------------------
if [[ ! -f $ENV_FILE ]]; then
  say "Creating settings file $ENV_FILE"
  cat >"$ENV_FILE" <<EOF
# Budgify settings. After editing, run: sudo systemctl restart budgify

# Bank connections (https://dashboard.plaid.com -> Developers -> Keys)
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox
PLAID_COUNTRY_CODES=US
SYNC_INTERVAL_HOURS=6

# Server (leave these as they are: Tailscale provides HTTPS in front of 127.0.0.1)
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR
COOKIE_SECURE=true
TRUST_PROXY=1
EOF
  # Bring over Plaid keys from a .env next to the code, if there is one.
  if [[ -f $SRC_DIR/.env ]]; then
    for k in PLAID_CLIENT_ID PLAID_SECRET PLAID_ENV PLAID_COUNTRY_CODES PLAID_REDIRECT_URI ENCRYPTION_KEY; do
      v=$(grep -E "^$k=" "$SRC_DIR/.env" | tail -1 | cut -d= -f2- || true)
      [[ -n $v ]] || continue
      if grep -qE "^$k=" "$ENV_FILE"; then sed -i "s|^$k=.*|$k=$v|" "$ENV_FILE"; else echo "$k=$v" >>"$ENV_FILE"; fi
    done
    echo "Copied Plaid settings from $SRC_DIR/.env"
  fi
fi
chown root:"$SVC_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# --- helper command ---------------------------------------------------------------------
cat >/usr/local/bin/budgify <<'EOF'
#!/usr/bin/env bash
# budgify status | logs | restart | backup | reset-password | settings | url
set -euo pipefail
run_as_app() { sudo -u budgify bash -c 'set -a; . /etc/budgify/budgify.env; set +a; cd /opt/budgify; exec "$@"' _ "$@"; }
case "${1:-help}" in
  status) systemctl status budgify --no-pager ;;
  logs) journalctl -u budgify -n 200 -f ;;
  restart) sudo systemctl restart budgify && echo "Restarted." ;;
  backup) run_as_app node --disable-warning=ExperimentalWarning scripts/backup.js ;;
  reset-password) run_as_app node --disable-warning=ExperimentalWarning scripts/reset-password.js ;;
  settings) sudo "${EDITOR:-nano}" /etc/budgify/budgify.env && sudo systemctl restart budgify && echo "Saved and restarted." ;;
  url) tailscale serve status 2>/dev/null || echo "Tailscale is not serving Budgify yet." ;;
  *) echo "Usage: budgify status|logs|restart|backup|reset-password|settings|url" ;;
esac
EOF
chmod 755 /usr/local/bin/budgify

if [[ ${BUDGIFY_SKIP_SYSTEMD:-} == 1 ]]; then
  warn "BUDGIFY_SKIP_SYSTEMD=1: files installed, service not started."
  exit 0
fi

# --- systemd service + nightly backup --------------------------------------------------
say "Setting up the Budgify service"
cat >/etc/systemd/system/budgify.service <<EOF
[Unit]
Description=Budgify budgeting app
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=3
# Hardening: read-only system, writable data dir only, no privilege escalation.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$DATA_DIR
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/budgify-backup.service <<EOF
[Unit]
Description=Back up the Budgify database

[Service]
Type=oneshot
User=$SVC_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning scripts/backup.js
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
UMask=0077
EOF

cat >/etc/systemd/system/budgify-backup.timer <<EOF
[Unit]
Description=Nightly Budgify backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now budgify.service budgify-backup.timer >/dev/null
systemctl restart budgify.service
sleep 2
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login"; then
  echo "Budgify is running on 127.0.0.1:$PORT"
else
  warn "Budgify didn't answer yet. Check: budgify logs"
fi

# --- Tailscale (private HTTPS access) ------------------------------------------------------
if [[ ${BUDGIFY_SKIP_TAILSCALE:-} == 1 ]]; then
  warn "Skipping Tailscale. Put an HTTPS reverse proxy in front of 127.0.0.1:$PORT yourself."
  exit 0
fi

if ! command -v tailscale >/dev/null; then
  say "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  say "Connect this server to your Tailscale account"
  echo "Open the link below on any device and sign in with the SAME account you use on your phone."
  tailscale up --ssh
fi

say "Publishing Budgify privately over HTTPS"
if tailscale serve --bg "$PORT"; then
  URL=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).Self.DNSName||"";console.log(n?"https://"+n.replace(/\.$/,""):"")})')
  say "Done! Open Budgify at:  ${URL:-(run: budgify url)}"
  echo "Only devices signed in to your Tailscale account can open it."
  echo "Next: add your Plaid keys with  budgify settings"
else
  warn "Tailscale couldn't publish HTTPS. In the Tailscale admin console (DNS page) turn on"
  warn "MagicDNS and HTTPS Certificates, then run:  sudo tailscale serve --bg $PORT"
fi
