# Tailscale SSH on Firebase Studio — Complete Deployment Guide

Firebase Studio (formerly Project IDX) is a browser-based cloud IDE. This guide enables **full TTY SSH access** from your local machine via Tailscale, solving the limitation that Firebase Studio's native SSH (port 2222) has no TTY support.

## Architecture

```
Local Machine                    Firebase Studio Workspace
┌──────────────┐                 ┌──────────────────────────┐
│  Windows PC  │  Tailscale SSH  │  NixOS Container         │
│  (tag:worker)│ ◄─────────────► │  tailscaled (userspace)  │
│              │    Full TTY     │  (tag:shrimp-workshop)   │
└──────────────┘                 └──────────────────────────┘
```

## Prerequisites

- [Tailscale](https://tailscale.com/) installed on local machine + joined to tailnet
- Firebase Studio workspace (browser access)
- Tailscale admin access (for ACLs and auth keys)

---

## Step 1: Configure `dev.nix`

Ensure your `.idx/dev.nix` includes `pkgs.tailscale`:

```nix
{ pkgs, ... }: {
  channel = "stable-23.11";
  packages = [
    pkgs.nodejs_20
    pkgs.tailscale
    pkgs.openssh
  ];
};
```

This branch's `dev.nix` also includes auto-start hooks. See [.idx/dev.nix](./.idx/dev.nix).

## Step 2: Generate Tailscale Auth Key

1. Go to [Tailscale Admin → Settings → Keys](https://login.tailscale.com/admin/settings/keys)
2. Click **Generate auth key**
3. Settings:
   - **Reusable**: Yes (workspace may restart)
   - **Ephemeral**: No
   - **Tags**: Select the tag for this workspace (e.g. `tag:shrimp-workshop`)
4. Copy the key (format: `tskey-auth-XXXX-YYYYYYYY`)

> **Important:** Tags must be defined in ACL `tagOwners` first. See Step 5.

## Step 3: Set Auth Key as Firebase Studio Secret

1. In Firebase Studio, click **gear icon** → **Project Settings** → **Secrets**
2. Add: Name = `TAILSCALE_AUTHKEY`, Value = your auth key
3. The workspace's `onStart` hook will read this automatically

## Step 4: Start Tailscale

### Option A: Automatic (via `dev.nix` onStart)

If you set the `TAILSCALE_AUTHKEY` secret, the workspace auto-starts Tailscale on boot. Just rebuild the workspace.

### Option B: Run setup script

```bash
chmod +x setup-tailscale.sh
TAILSCALE_AUTHKEY=tskey-auth-XXXX-YYYYYYYY ./setup-tailscale.sh
```

### Option C: Manual commands

```bash
# 1. Start daemon
nohup tailscaled \
  --tun=userspace-networking \
  --socket=/tmp/tailscaled.sock \
  --statedir=/home/user/.tailscale-state \
  --socks5-server=127.0.0.1:1055 &

# 2. Wait for socket
sleep 2

# 3. Authenticate (with auth key)
tailscale --socket=/tmp/tailscaled.sock up \
  --authkey=tskey-auth-XXXX-YYYYYYYY \
  --hostname=my-workspace \
  --accept-routes \
  --ssh

# 4. Verify
tailscale --socket=/tmp/tailscaled.sock status
tailscale --socket=/tmp/tailscaled.sock ip -4
```

**Key flags:**
- `--tun=userspace-networking` — Required; no TUN device in container
- `--socket=/tmp/tailscaled.sock` — Custom socket (no root)
- `--ssh` — Enables Tailscale SSH server (critical!)

## Step 5: Configure Tailscale ACLs

Go to [Tailscale Admin → Access Controls](https://login.tailscale.com/admin/acls):

```jsonc
{
  "tagOwners": {
    "tag:shrimp-workshop": ["autogroup:admin"],
    "tag:worker":          ["autogroup:admin"]
  },

  "grants": [
    { "src": ["*"], "dst": ["*"], "ip": ["*"] }
  ],

  "ssh": [
    // Allow tagged devices to SSH into each other
    {
      "action": "accept",
      "src":    ["autogroup:member", "tag:worker", "tag:shrimp-workshop"],
      "dst":    ["tag:shrimp-workshop", "tag:worker"],
      "users":  ["root", "user"]
    },
    // Allow members to SSH into their own devices
    {
      "action": "check",
      "src":    ["autogroup:member"],
      "dst":    ["autogroup:self"],
      "users":  ["autogroup:nonroot", "root"]
    }
  ]
}
```

### ACL Gotchas

| Trap | Explanation |
|---|---|
| **Tagged device ≠ autogroup:member** | A device with a tag is removed from `autogroup:member`. Your local machine's tag must be in `src`. |
| **`dst` restrictions** | SSH `dst` only accepts: `autogroup:self`, `autogroup:tagged`, `tag:xxx`, or users. NOT `*`, `autogroup:member`, IPs. |
| **Check your local machine** | Run `tailscale whois <your-ip>` — if it shows a tag, add that tag to `src`. |

## Step 6: Fix PATH for External SSH

External SSH sessions don't inherit the IDX Nix environment. The `setup-tailscale.sh` script handles this automatically, but you can also do it manually:

```bash
# Find idx-builtins path
IDX_BIN=$(find /nix/store -maxdepth 2 -path '*/idx-builtins/bin' -type d 2>/dev/null | head -1)

# Check if already fixed
grep -q '_IDX_PATH_LOADED' ~/.bashrc && echo "Already done" && exit 0

# Prepend PATH block (MUST be before 'case $- in ... return' block)
cat > /tmp/path_fix.sh << EOF
# === IDX Nix PATH for external SSH ===
if [ -z "\${_IDX_PATH_LOADED}" ]; then
  export _IDX_PATH_LOADED=1
  export PATH="/home/user/.global_modules/bin:/home/user/.opencode/bin:/home/user/bin:/home/user/.npm-global/bin:/home/user/local/bin:\${PATH}:${IDX_BIN}"
fi
EOF

cp ~/.bashrc ~/.bashrc.bak
cat /tmp/path_fix.sh ~/.bashrc.bak > ~/.bashrc
```

**PATH priority**: `.global_modules/bin` (user-installed) > `.npm-global/bin` > system > `idx-builtins` (fallback). User-installed tools take priority over IDX built-in versions.

## Step 7: Connect

```powershell
# From your local Windows machine
tailscale ssh user@<hostname>

# Remote command execution
tailscale ssh user@<hostname> -- "node test.js"
```

---

## File Transfer Methods

### rsync (recommended, via WSL)

```powershell
wsl rsync -avz -e "ssh -p 2222 -o StrictHostKeyChecking=no" \
  /mnt/c/Users/<USER>/src/ user@<TAILSCALE_IP>:/dest/
```

### SCP (requires `-O` flag)

```bash
scp -P 2222 -O file.txt user@<IP>:/remote/path/
```

Default SCP uses SFTP internally, which is broken on Firebase Studio. `-O` forces legacy protocol.

### SFTP (requires `-s` flag)

```bash
SFTP_BIN=$(ssh -p 2222 user@<IP> "find /nix/store -name sftp-server -type f 2>/dev/null | head -1")
sftp -P 2222 -s "$SFTP_BIN" user@<IP>
```

Default SFTP subsystem is broken. `-s` specifies the server binary directly.

---

## Troubleshooting

### "tailnet policy does not permit you to SSH"

1. Check your local device's tags: `tailscale whois <your-ip>`
2. If tagged, add that tag to the SSH ACL `src` field
3. Ensure the workspace's tag is in the SSH ACL `dst` field

### Commands not found (gemini, node, etc.)

Re-run the PATH fix from Step 6, or run `setup-tailscale.sh`.

### "failed to connect to local tailscaled"

The `tailscale` command defaults to the system socket. Always use:
```bash
tailscale --socket=/tmp/tailscaled.sock <command>
```

### Workspace rebuilt, Tailscale gone

Re-run `./setup-tailscale.sh` or set the `TAILSCALE_AUTHKEY` secret for auto-start.

### Nix store paths changed

```bash
find /nix/store -name sftp-server -type f 2>/dev/null | head -1
find /nix/store -path '*/idx-builtins/bin' -type d 2>/dev/null | head -1
```
