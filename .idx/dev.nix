{ pkgs, ... }: {
  channel = "stable-23.11";
  packages = [
    pkgs.nodejs_20
    pkgs.tailscale
    pkgs.openssh
  ];
  idx.workspace.onStart = {
    welcome = "echo 'Welcome to Shrimp JSONGuard Workshop! Testing infrastructure is ready.'";
    # Tailscale SSH auto-start (requires TAILSCALE_AUTHKEY secret in Firebase Studio)
    tailscale-daemon = ''
      echo "[tailscale] Starting tailscaled in userspace-networking mode..."
      mkdir -p /home/user/.tailscale-state
      nohup tailscaled \
        --tun=userspace-networking \
        --socket=/tmp/tailscaled.sock \
        --statedir=/home/user/.tailscale-state \
        --socks5-server=127.0.0.1:1055 \
        > /tmp/tailscaled.log 2>&1 &
      sleep 2
      if [ -n "$TAILSCALE_AUTHKEY" ]; then
        echo "[tailscale] Auth key detected, joining tailnet..."
        tailscale --socket=/tmp/tailscaled.sock up \
          --authkey="$TAILSCALE_AUTHKEY" \
          --hostname="$(echo $PROJECT_ID | cut -d'-' -f1-3)" \
          --accept-routes \
          --ssh
        echo "[tailscale] Connected! IP: $(tailscale --socket=/tmp/tailscaled.sock ip -4 2>/dev/null)"
      else
        echo "[tailscale] No TAILSCALE_AUTHKEY set. Run setup-tailscale.sh manually."
      fi
    '';
    # Fix PATH for external SSH sessions
    fix-ssh-path = ''
      if ! grep -q '_IDX_PATH_LOADED' /home/user/.bashrc 2>/dev/null; then
        echo "[ssh-path] Injecting IDX PATH into ~/.bashrc for external SSH..."
        IDX_BIN=$(find /nix/store -maxdepth 2 -path '*/idx-builtins/bin' -type d 2>/dev/null | head -1)
        cat > /tmp/idx_path_block.sh << PATHEOF
# === IDX Nix PATH for external SSH ===
if [ -z "\${_IDX_PATH_LOADED}" ]; then
  export _IDX_PATH_LOADED=1
  export PATH="/home/user/.global_modules/bin:/home/user/.opencode/bin:/home/user/bin:/home/user/.npm-global/bin:/home/user/local/bin:\${PATH}:${IDX_BIN:-/usr/bin}"
fi
PATHEOF
        cp /home/user/.bashrc /home/user/.bashrc.bak.$(date +%s) 2>/dev/null || true
        cat /tmp/idx_path_block.sh /home/user/.bashrc > /tmp/bashrc_merged
        mv /tmp/bashrc_merged /home/user/.bashrc
        echo "[ssh-path] PATH injection complete."
      fi
    '';
  };
}
