# Run Budgify 24/7 for free, private to you

This guide puts Budgify on a free cloud server that's always on. You reach it from your phone and computer at a private HTTPS address that **only your own devices can open**. Nothing is exposed to the public internet.

```
 your phone ─┐                         ┌─────────── free cloud VM ───────────┐
             ├── Tailscale (encrypted) ─┤  tailscale serve (HTTPS)            │
 your laptop ┘   only your devices     │        │                            │
                                       │  Budgify on 127.0.0.1:3000          │
                                       │  data: /var/lib/budgify + nightly   │
                                       │        backups                      │
                                       └─────────────────────────────────────┘
```

- **Server:** Oracle Cloud "Always Free" Ubuntu VM ($0).
- **Private access:** [Tailscale](https://tailscale.com), free Personal plan. It works like a private network between your own devices.
- **Install:** one command (`deploy/install.sh`) sets up Node, the app, a service that restarts on reboot or crash, nightly backups and Tailscale HTTPS.

> **Read this first.** Both Oracle and Tailscale ask for an account, and Oracle asks for a credit card to verify you're a real person. The resources below cost $0 as long as you stay inside the Always Free limits, and step 2 shows how to set a spending alert so you'd know if anything ever did cost money. Free-tier terms change, so check [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) for the current limits.

## 1. Set up Tailscale (5 min)

1. Create a free account at <https://login.tailscale.com/start>.
2. Install the Tailscale app on your **phone** and your **computer** and sign in to both.
3. In the [admin console → DNS](https://login.tailscale.com/admin/dns), turn on **MagicDNS** and **HTTPS Certificates**.

## 2. Create the free server (15 min)

1. Sign up at <https://www.oracle.com/cloud/free/>. Choose a **home region** near you; Always Free compute only runs there, and you can't change it later.
2. **Recommended:** upgrade the account to **Pay As You Go** (*Billing → Upgrade and Manage Payment*). Always Free resources stay free. It also stops Oracle reclaiming your VM for being "idle", which a personal budgeting app usually is. Then set a **budget alert** of $1 (*Billing → Budgets*) so you'd hear about any unexpected charge.
3. Go to *Compute → Instances → Create instance*:
   - **Image:** Canonical **Ubuntu 24.04**
   - **Shape:** *Ampere* **VM.Standard.A1.Flex** with 1 OCPU and 6 GB memory, which is plenty for Budgify. If it says "out of capacity", pick **VM.Standard.E2.1.Micro** (AMD, also Always Free) or try again later.
   - **Networking:** keep the defaults, with a public IPv4 address. The server needs it for setup, and it's free on Oracle.
   - **SSH keys:** choose *Generate a key pair for me* and **download the private key**.
   - Click **Create**, wait until it's *Running*, and copy its **public IP address**.

## 3. Install Budgify (10 min)

Connect to the server. On Windows, use PowerShell; on a Mac, use Terminal:

```bash
ssh -i path/to/downloaded-key.key ubuntu@YOUR_PUBLIC_IP
```

> On a Mac, run `chmod 600 path/to/downloaded-key.key` first if ssh complains about permissions.

Then paste this:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone -b claude/budgeting-tool-bank-integration-cj476g https://github.com/BJGajjar669/Budgeting-Tool.git budgify
cd budgify && sudo ./deploy/install.sh
```

<details>
<summary>If you've made the repository private</summary>

The server then needs permission to download it. Give it a **deploy key**, a key that can only *read* this one repository, by running this on the server:

```bash
ssh-keygen -t ed25519 -N "" -C budgify-server -f ~/.ssh/budgify_deploy
printf 'Host github.com\n  IdentityFile ~/.ssh/budgify_deploy\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
cat ~/.ssh/budgify_deploy.pub
```

Copy the line it prints (it starts with `ssh-ed25519`). On GitHub, go to your repository's **Settings → Deploy keys → Add deploy key**, paste it, and **leave "Allow write access" unticked**. Then clone with `git@github.com:BJGajjar669/Budgeting-Tool.git` in place of the `https://…` address above.
</details>

Partway through, it prints a **Tailscale login link**. Open it and sign in with the same Tailscale account you used on your phone. At the end it prints your private address, something like:

```
==> Done! Open Budgify at:  https://budgify-vm.tail1234.ts.net
```

## 4. Open it on your phone and computer

1. Make sure Tailscale is switched on, then open that address.
2. Create your Budgify account. The first visit asks for it; after that it's sign-in only.
3. On your phone, add it to the home screen:
   - **iPhone (Safari):** tap **Share → Add to Home Screen**.
   - **Android (Chrome):** tap **⋮ → Add to Home screen**.

   Budgify then opens full-screen with its own icon.

Both devices use the same data on the server, so they're always in step. Each device signs in on its own.

## 5. Lock it down (recommended, 2 min)

The installer enabled **Tailscale SSH**, so you no longer need the public SSH port.

1. Check that this works from your computer while Tailscale is on: `ssh ubuntu@budgify-vm`. Use your server's Tailscale name; `tailscale status` lists it.
2. In Oracle: *Networking → Virtual Cloud Networks → your VCN → Security Lists → Default* and **delete the ingress rule for port 22**.

Your server now has **no open ports on the internet**. Budgify is only reachable through Tailscale.

## 6. Connect your banks

```bash
budgify settings      # opens the settings file; add PLAID_CLIENT_ID and PLAID_SECRET, save, and it restarts
```

Set `PLAID_ENV=production` once Plaid approves you for live data. For banks with an OAuth login (Chase, Wells Fargo, …), also set `PLAID_REDIRECT_URI=https://budgify-vm.tail1234.ts.net/` (your own address) and add the same URI in the Plaid dashboard.

## Everyday commands (on the server)

| Command | What it does |
|---|---|
| `budgify status` | Is it running? |
| `budgify logs` | Live log (Ctrl+C to exit) |
| `budgify restart` | Restart the app |
| `budgify settings` | Edit settings, e.g. Plaid keys (restarts automatically) |
| `budgify backup` | Take a backup now (one runs automatically every night; the last 14 are kept) |
| `budgify reset-password` | Forgot your Budgify password |
| `budgify url` | Show the private address |

**Update to a newer version:** `cd ~/budgify && git pull && sudo ./deploy/install.sh`. Your data and settings are kept.

**Keep an off-server copy of your backups** every so often. Run this on your computer:

```bash
ssh ubuntu@budgify-vm 'sudo tar -C /var/lib/budgify -czf - backups' > budgify-backups.tgz
```

**Restore a backup:**

```bash
sudo systemctl stop budgify
sudo -u budgify cp /var/lib/budgify/backups/budget-YYYY-MM-DD.db /var/lib/budgify/budget.db
sudo rm -f /var/lib/budgify/budget.db-wal /var/lib/budgify/budget.db-shm
sudo systemctl start budgify
```

## Other places it can run

`deploy/install.sh` works on any Ubuntu or Debian machine:

- **Google Cloud e2-micro** (us-west1, us-central1 or us-east1): reliable and never reclaimed. In 2026 Google bills its public IPv4 address at about $3.65 a month, so it's "nearly free" rather than free.
- **An old laptop or Raspberry Pi at home**, running Raspberry Pi OS or Ubuntu: $0 with no cloud account, but it only works while that machine is on.

Free app hosts that sleep or wipe their disk (Render's free tier, for example) **won't work**: Budgify keeps your data on disk and needs to stay running to sync your banks.
