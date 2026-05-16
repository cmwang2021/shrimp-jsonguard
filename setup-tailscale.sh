#!/bin/bash
# ============================================================
# setup-tailscale.sh — Firebase Studio Tailscale SSH Setup
# ============================================================
# Usage:
#   1. Auto mode (with auth key):
#      TAILSCALE_AUTHKEY=tskey-auth-XXXX ./setup-tailscale.sh
#
#   2. Manual mode (browser auth):
#      ./setup-tailscale.sh
#
# Prerequisites:
#   - Firebase Studio workspace with pkgs.tailscale in dev.nix
#   - Tailscale ACLs configured (see README)
# ============================================================

set -euo pipefail

SOCKET="/tmp/tailscaled.sock"
STATE_DIR="/home/user/.tailscale-state"
HOSTNAME="${TAILSCALE_HOSTNAME:-$(hostname | cut -d'-' -f1-3)}"
SOCKS_PORT="${TAILSCALE_SOCKS_PORT:-1055}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# --- Step 1: Start tailscaled ---
start_daemon() {
  if [ -S "$SOCKET" ] && tailscale --socket="$SOCKET" status &>/dev/null; then
    log "✅ tailscaled is already running."
    return 0
  fi

  log "🚀 Starting tailscaled (userspace-networking mode)..."
  mkdir -p "$STATE_DIR"

  nohup tailscaled \
    --tun=userspace-networking \
    --socket="$SOCKET" \
    --statedir="$STATE_DIR" \
    --socks5-server="127.0.0.1:${SOCKS_PORT}" \
    > /tmp/tailscaled.log 2>&1 &

  # Wait for socket
  for i in $(seq 1 10); do
    [ -S "$SOCKET" ] && break
    sleep 1
  done

  if [ ! -S "$SOCKET" ]; then
    log "❌ tailscaled failed to start. Check /tmp/tailscaled.log"
    exit 1
  fi
  log "✅ tailscaled started (PID: $(pgrep -f tailscaled | head -1))"
}

# --- Step 2: Authenticate ---
authenticate() {
  # Check if already connected
  if tailscale --socket="$SOCKET" status &>/dev/null 2>&1; then
    CURRENT_IP=$(tailscale --socket="$SOCKET" ip -4 2>/dev/null || echo "")
    if [ -n "$CURRENT_IP" ]; then
      log "✅ Already authenticated. IP: $CURRENT_IP"
      return 0
    fi
  fi

  if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
    log "🔑 Authenticating with auth key (hostname: $HOSTNAME)..."
    tailscale --socket="$SOCKET" up \
      --authkey="$TAILSCALE_AUTHKEY" \
      --hostname="$HOSTNAME" \
      --accept-routes \
      --ssh
  else
    log "🌐 No TAILSCALE_AUTHKEY found. Starting interactive auth..."
    log "   A URL will be printed below. Open it in your browser to authenticate."
    tailscale --socket="$SOCKET" up \
      --hostname="$HOSTNAME" \
      --accept-routes \
      --ssh
  fi

  CURRENT_IP=$(tailscale --socket="$SOCKET" ip -4 2>/dev/null || echo "unknown")
  log "✅ Connected! Tailscale IP: $CURRENT_IP"
}

# --- Step 3: Fix PATH for external SSH ---
fix_ssh_path() {
  if grep -q '_IDX_PATH_LOADED' /home/user/.bashrc 2>/dev/null; then
    log "✅ SSH PATH already configured."
    return 0
  fi

  log "🔧 Injecting IDX PATH into ~/.bashrc..."
  IDX_BIN=$(find /nix/store -maxdepth 2 -path '*/idx-builtins/bin' -type d 2>/dev/null | head -1)

  cat > /tmp/idx_path_block.sh << PATHEOF
# === IDX Nix PATH for external SSH ===
if [ -z "\${_IDX_PATH_LOADED}" ]; then
  export _IDX_PATH_LOADED=1
  export PATH="/home/user/.global_modules/bin:/home/user/.opencode/bin:/home/user/bin:/home/user/.npm-global/bin:/home/user/local/bin:\${PATH}:${IDX_BIN:-/usr/bin}"
fi
PATHEOF

  cp /home/user/.bashrc "/home/user/.bashrc.bak.$(date +%s)" 2>/dev/null || true
  cat /tmp/idx_path_block.sh /home/user/.bashrc > /tmp/bashrc_merged
  mv /tmp/bashrc_merged /home/user/.bashrc
  log "✅ PATH injection complete."
}

# --- Step 4: Verify ---
verify() {
  log "--- Verification ---"
  log "Hostname: $(tailscale --socket="$SOCKET" debug prefs 2>&1 | grep Hostname | tr -d '[:space:]",' | cut -d: -f2)"
  log "IP:       $(tailscale --socket="$SOCKET" ip -4 2>/dev/null || echo 'N/A')"
  log "SSH:      $(tailscale --socket="$SOCKET" debug prefs 2>&1 | grep RunSSH | tr -d '[:space:]",' | cut -d: -f2)"
  log ""
  log "From your local machine, connect with:"
  log "  tailscale ssh user@${HOSTNAME}"
  log ""
  log "To check status anytime:"
  log "  tailscale --socket=$SOCKET status"
}

# --- Main ---
log "=== Firebase Studio Tailscale SSH Setup ==="
start_daemon
authenticate
fix_ssh_path
verify
log "=== Setup Complete ==="
