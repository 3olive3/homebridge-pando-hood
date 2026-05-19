# homebridge-pando-hood

Homebridge plugin for Pando kitchen hoods (AirLink Wi-Fi) — bridges them into Apple HomeKit. **Public GitHub repo.**

## Purpose

Exposes Pando hood fan control (4 speeds), light (brightness + 2700–6000K color temperature), filter maintenance, clean-air mode, and timer to HomeKit. Talks to the PGA IoT cloud API (`pando.iotpga.it`) — the same backend the official Pando app uses.

## Stack

- TypeScript 5.7
- Node.js 18–22
- Homebridge ≥ 1.6.0
- `tsc` → `dist/`
- No deps beyond the Homebridge API

## Layout

```
src/
  index.ts          # Plugin entry — exports platform class
  settings.ts       # Constants, log prefix
  platform.ts       # Discovery, accessory lifecycle
  accessory.ts      # HomeKit characteristic handlers
  api-client.ts     # PGA IoT REST client (auth, token refresh, polling)
dist/               # tsc output (committed for npm install)
config.schema.json  # Homebridge UI config schema
package.json
README.md
```

## Commands

```bash
npm install
npm run build              # tsc → dist/
npm run lint
npm run watch              # tsc --watch during development
npm publish                # release to npm (after version bump)
```

Local install for testing against Homebridge:
```bash
npm link
# inside Homebridge container/host:
npm link homebridge-pando-hood
# restart Homebridge
```

## Integration

- **Cloud API**: `pando.iotpga.it` (undocumented, reverse-engineered)
- **Auth**: user email + password (token auto-refresh every 4 hours)
- **Runtime**: Homebridge child bridge on UNRAID, device `0E:46:B4:3B:7E:12`
- **Live URL**: `homebridge.3olive3.com` → 10.1.6.30:8124 (NPM proxy)
- **Monitoring**: Uptime Kuma monitor #34 (Pando IoT)

## Skills installed

Available via the skill tool — symlinked into `.claude/skills/` from `~/Developer/atelier-catalog/skills/`.

**Casa Lima mandatory** (every repo): `vault-access`, `build-image`, `deploy-container`, `incidents-methodology`, `distribute-skill-mcp`, `home-network`, `bash-pro`, `git-advanced-workflows`, `systematic-debugging`, `security-review`.

**This repo also has**: `api-design-principles`, `test-driven-development`.

## MCPs

See `.mcp.json`. Default-enabled: `homekit` (for testing characteristics against the live Homebridge).

## Gotchas

- **PUBLIC REPO** — never commit Casa Lima infrastructure references, account credentials, or internal hostnames. README + AGENTS material here should stay generic.
- Cloud-only — no local LAN control. Internet-dependent. 1–2s latency typical.
- Firmware quirks need workarounds in the plugin: auto-light suppression, auto-timer behavior, stale cloud state — see `accessory.ts` for the active hacks.
- PGA IoT API is reverse-engineered. If Pando changes their backend, this breaks; pin to `pando.iotpga.it` only.
- Token auto-refresh every 4 hours — failure mode triggers re-auth.
- Only E-297 model fully confirmed; other models marked TBD in README.

## More context

- home-docs (private): <https://docs.3olive3.com/smart-home/homebridge-plugins/pando-hood/>
- Disclaimer: README documents that endpoints are reverse-engineered.
