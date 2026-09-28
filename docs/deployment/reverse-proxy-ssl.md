# 🔒 Remote Access, Reverse Proxy & SSL Guide

Securing remote access to your estate operating system is paramount. **Never open port 80/443 directly on your residential router to an unauthenticated server.**

---

## 🛡️ Recommended: Cloudflare Tunnels (Zero Trust)

[Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) allow you to securely expose Household OS to your custom domain without opening inbound router firewall ports.

### Setup Steps:
1. In Cloudflare Zero Trust Dashboard, navigate to **Networks → Tunnels → Create a Tunnel**.
2. Run `cloudflared` on your homelab machine:
   ```bash
   docker run -d --name cloudflared --restart unless-stopped \
     cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <TUNNEL_TOKEN>
   ```
3. Configure Public Hostname in Cloudflare:
   * **Domain**: `estate.yourdomain.com`
   * **Service**: `HTTP` -> `localhost:5000` (or `household-app:5000` on the Docker network)
4. (Optional) Enable Cloudflare Access to add hardware security key (FIDO2/WebAuthn) or Google Workspace authentication in front of the application.

---

## 🦎 Option 2: Tailscale (Private Mesh VPN)

If you do not want your dashboard exposed to the public internet at all, use [Tailscale](https://tailscale.com/):

1. Install Tailscale on the machine running Household OS:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Enable MagicDNS and HTTPS certificates:
   ```bash
   sudo tailscale cert estate.your-tailnet.ts.net
   ```
3. Access your dashboard securely from any mobile phone or laptop connected to your personal Tailnet at `https://estate.your-tailnet.ts.net:5000`.

---

## 🚦 Option 3: Caddy Server (Automatic Let's Encrypt)

If hosting on a VPS with a public IP, Caddy provides automatic SSL provisioning:

```caddy
estate.yourdomain.com {
    reverse_proxy localhost:5000
}
```
Run:
```bash
caddy run --config Caddyfile
```
