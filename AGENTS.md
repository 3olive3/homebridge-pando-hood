# homebridge-pando-hood — AI Coding Rules & Project Handbook

> **Project handbook for any AI agent working on this codebase.**
> Read this file before making changes.

---

## 0) Project Identity

| Field           | Value                                                          |
|-----------------|----------------------------------------------------------------|
| Name            | **homebridge-pando-hood**                                      |
| Purpose         | Homebridge plugin for Pando kitchen hoods — exposes fan, light, filter, and clean air mode to Apple HomeKit via the PGA IoT cloud API |
| GitHub          | `github.com/3olive3/homebridge-pando-hood` (public)            |
| npm             | `homebridge-pando-hood`                                        |
| Owner / Admin   | Filipe Lima (`3olive3`)                                        |
| License         | MIT                                                            |
| Local path      | `~/Developer/Pando/`                                           |

### What this project IS

A TypeScript Homebridge plugin that bridges Pando kitchen hoods (AirLink Wi-Fi) into Apple HomeKit. Communicates with the PGA IoT cloud API (`pando.iotpga.it`) — the same backend used by the official Pando app. Exposes fan speed, light (brightness + color temp), filter maintenance, clean air mode, timer, and offline detection.

### What this project is NOT

- Not a local/LAN control solution — requires internet (cloud API only)
- Not affiliated with Pando or PGA2.0 S.R.L. — independent community project
- Not infrastructure — it's an npm package deployed via Homebridge UI

---

## 1) Architecture

### Tech Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js >= 18
- **Platform**: Homebridge >= 1.6.0
- **Build**: `tsc` -> `dist/`
- **API**: PGA IoT cloud (`pando.iotpga.it`) — REST + token auth (4-hour expiry, auto-refresh)

### Source Structure

```
src/
├── index.ts          # Plugin registration entry point
├── settings.ts       # Constants (plugin name, platform name)
├── platform.ts       # Platform class — discovery, accessory lifecycle
├── accessory.ts      # Accessory class — HomeKit services, state management
└── api-client.ts     # PGA IoT API client — auth, device polling, commands
```

### HomeKit Services Exposed

| Feature | HomeKit Service | Controls |
|---------|----------------|----------|
| Fan | Fan v2 | On/off, 4 speed levels (25% steps) |
| Light | Lightbulb | On/off, brightness (10-100%), color temperature (2700-6000K) |
| Filter | Filter Maintenance | Filter life %, change needed alert |
| Clean Air | AirPurifier | Toggle periodic ventilation mode |
| Timer | Switch | Toggle hood auto-off timer |
| Offline | StatusFault | Marks accessory faulted when device stops responding |

### Known Firmware Quirks

The Pando firmware has auto-behaviors that the plugin works around transparently:

1. **Auto-light on fan start** — plugin suppresses with immediate light-off command
2. **Auto-timer on fan start** — plugin suppresses with intent flag for entire fan session (not one-shot like light)
3. **Stale cloud state** — cloud API persists stale `timer.enable: 1` even after fan-off; plugin clears `this.state["device.timer.enable"] = 0` on fan-off to prevent HomeKit reconciliation loop

---

## 2) Deployment

### Current Device

| Field | Value |
|-------|-------|
| Model | E297/120 V1550e BL |
| Device ID | PAN-00004774 |
| Child bridge | `0E:46:B4:3B:7E:12` |
| Container | `homebridge` (lowercase) on UNRAID |

### Deploy Workflow

1. Build locally: `npm run build`
2. Commit & push to `develop`, merge to `main`
3. Clone on UNRAID: `git clone --depth 1 --branch main` to `/tmp/pando-deploy`
4. Copy dist into container: `docker cp /tmp/pando-deploy/dist/. homebridge:/homebridge/node_modules/homebridge-pando-hood/dist/`
5. Restart child bridge via HomeKit MCP: `0E:46:B4:3B:7E:12`

> **Note**: SSH from macOS to UNRAID (10.1.3.2:22) is blocked — use UNRAID MCP (`run_command`) or git clone from UNRAID shell.

---

## 3) Key Rules

- **Public repo** — no Casa Lima infrastructure details, no secrets, no internal IPs
- **npm package** — changes to `package.json` version require a changelog entry
- **Firmware workarounds are fragile** — test thoroughly before modifying `accessory.ts` auto-suppression logic
- **Cloud API has no documentation** — all endpoints were reverse-engineered from the Pando app
- `dist/` is committed (required for npm publish)
- No secrets in the codebase — Pando credentials are configured by end users in their Homebridge config

---

## Casa Lima — Universal Guardrails

> **These rules are non-negotiable across all Casa Lima repositories.**

### Git Branching Discipline

- `main` is production-ready — **never push directly**
- `develop` is the integration branch
- Feature work: `feature/*` branches off `develop`
- Bug fixes: `bugfix/*` branches off `develop`
- Merge to `develop` via PR, then `develop` to `main` via PR
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`

### Secrets Management

No password, secret, token, API key, or credential may be stored anywhere other than **Vaultwarden** (`vault.3olive3.com`). Never write secrets to code, config files, `.env` files committed to git, logs, comments, or documentation.

- Vaultwarden user: `administrator@3olive3.com`
- Never ask the user to paste passwords in chat
- When creating new credentials, generate a strong password and store it in Vaultwarden

### No Destructive Actions Without Explicit User Approval

Never execute destructive operations on UNRAID, Fortigate, Pihole, or any other system without asking the user first and receiving explicit confirmation. This includes: deleting containers, modifying firewall rules, deleting files, reformatting disks, shutting down services. **For all deletions: a backup must be generated and a rollback plan prepared.**

### No Firewall Changes Without Explicit User Approval

Never execute any write, update, or delete operation on the Fortigate firewall without presenting the proposed change and receiving explicit confirmation. This applies to ALL Fortigate write tools — policies, service objects, address objects, DHCP reservations, static routes.

### Prefer MCP Over SSH

When interacting with infrastructure (UNRAID, Pihole, NGINX Proxy Manager, Fortigate, etc.), always prefer the corresponding MCP server. Only fall back to SSH/API when the MCP server is not connected. All fallback credentials are in Vaultwarden.

### Ops Readiness Before Production

Every new service deployed must have monitoring in Uptime Kuma before being production-ready. Requirements: appropriate monitor type, correct status codes, proper naming (`Service Name (Description)`).

### MkDocs Sync After Push to home-docs

After pushing to the `home-docs` repo, trigger the UNRAID sync immediately:
```bash
# Via UNRAID MCP run_command:
/mnt/user/appdata/mkdocs-sync.sh
```

### Project Journals

For any multi-session project, maintain a project journal at `~/.config/opencode/journal/active/<project-slug>.md`. At session start, check for existing journals and read them. After every local change, update the journal.

---

## Casa Lima — Infrastructure Reference

### Infrastructure Overview

| Component | Details |
|-----------|---------|
| **Server** | HP ProLiant DL380 Gen9, 2x Xeon E5-2697 v3, 128GB RAM (UNRAID) |
| **Firewall** | Fortigate 61F HA cluster + 2x FortiSwitch + 3x FortiAP-231F |
| **DNS** | Pihole (primary for all VLANs), Cloudflare (external) |
| **Reverse Proxy** | NGINX Proxy Manager |
| **Smart Home** | HomeKit via Homebridge + Shelly devices |
| **Secrets** | Vaultwarden (`vault.3olive3.com`) |
| **Docs** | MkDocs Material (`docs.3olive3.com`) |
| **Backups** | Duplicacy to Backblaze B2 |
| **Media** | Plex + Sonarr + Radarr + SABnzbd + Overseerr |
| **Monitoring** | Prometheus/Grafana, Uptime Kuma, Tautulli |
| **Domain** | `3olive3.com` (Cloudflare) |

### MCP Servers (17 total)

All built in `~/Developer/blok-butler/mcp/` and declared per-repo in `opencode.json`.

| Server | Category | Purpose |
|--------|----------|---------|
| unraid | Core | Docker, VMs, shares, system management |
| pihole | Core | DNS management, ad blocking |
| nginx | Core | Proxy hosts, SSL, redirects |
| fortigate | Core | Firewall policies, DHCP, routes |
| homekit | Core | Smart home control via Homebridge |
| cloudflare | Networking | DNS zones, tunnels, WAF |
| ipam | Networking | IP address management (NetBox) |
| iperf3 | Networking | Bandwidth testing |
| unimus | Networking | Network device config backup |
| plex | Media | Media server management |
| tautulli | Media | Plex monitoring and statistics |
| media-stack | Media | Sonarr/Radarr media automation |
| overseerr | Media | Media request management |
| duplicacy | Ops | Backup management |
| observability | Ops | Prometheus monitoring |
| uptime-kuma | Ops | Uptime monitoring and alerting |
| shelly | Ops | Shelly smart device control |

### Repository Map

```
~/Developer/
├── Agents-Teams/       # Infrastructure, cross-repo operations
├── BLOK/               # iOS app (SwiftUI + Vapor)
├── blok-butler/        # AI home intelligence (Node.js, 17 MCP servers)
├── home-docs/          # MkDocs knowledge base (docs.3olive3.com)
├── minecraft-server/   # Minecraft game server on UNRAID
├── agents-qa/          # QA and testing across all repos
├── atelier/            # Atelier.ai — visual AI team designer (SwiftUI)
├── atelier-mcps/       # MCP server distribution catalog
├── Pando/              # Homebridge plugin for Pando kitchen hoods
└── IPAM AND DNS/       # DHCP-to-DNS sync pipeline
```
