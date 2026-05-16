# 🦐 Shrimp JSONGuard × Firebase Studio Tailscale SSH

> **Branch: `feature/firebase-studio-tailscale-ssh`**
> This branch extends [shrimp-jsonguard](https://github.com/cmwang2021/shrimp-jsonguard) with a complete **Tailscale SSH deployment** on Firebase Studio, enabling full TTY remote access to the cloud workspace.

## 🎯 What This Branch Adds

| File | Purpose |
|---|---|
| `.idx/dev.nix` | Auto-starts Tailscale daemon + fixes SSH PATH on workspace boot |
| `setup-tailscale.sh` | One-command Tailscale SSH setup script |
| `TAILSCALE-SSH-GUIDE.md` | Complete step-by-step deployment guide |

## ⚡ Quick Start

### 1. Open in Firebase Studio

[![Open in Firebase Studio](https://firebase.google.com/static/images/integrations/idx/open-in-idx-button-dark.svg)](https://idx.google.com/import?url=https://github.com/cmwang2021/shrimp-jsonguard/tree/feature/firebase-studio-tailscale-ssh)

### 2. Set Auth Key as Secret

In Firebase Studio:
1. Click the **gear icon** → **Project Settings** → **Secrets**
2. Add secret: `TAILSCALE_AUTHKEY` = your auth key (from [Tailscale Admin](https://login.tailscale.com/admin/settings/keys))

### 3. Run Setup (if auto-start didn't trigger)

```bash
chmod +x setup-tailscale.sh
./setup-tailscale.sh
```

### 4. Connect from Local Machine

```powershell
tailscale ssh user@<your-hostname>
```

## 📖 Full Guide

See [TAILSCALE-SSH-GUIDE.md](./TAILSCALE-SSH-GUIDE.md) for the complete SOP including:
- Tailscale ACL configuration
- Troubleshooting (policy denied, commands not found, etc.)
- SFTP/SCP/rsync workarounds for file transfer

## 🧪 Test the Original Project

```bash
node test.js
```

---

Built with ❤️ by Shrimp Clan (蝦家班). Part of the "One Dollar Project".
