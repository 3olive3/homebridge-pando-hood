# CLAUDE.md

Homebridge plugin for Pando kitchen hoods — bridges to Apple HomeKit via PGA IoT cloud API.

## Commands

```bash
# Install dependencies
npm install

# Build
npm run build

# Lint
npm run lint
```

## Architecture

TypeScript Homebridge plugin. Communicates with PGA IoT cloud API (`pando.iotpga.it`). Token auth with 4-hour expiry + auto-refresh.

```
src/
├── index.ts          # Plugin registration
├── settings.ts       # Constants
├── platform.ts       # Discovery, accessory lifecycle
├── accessory.ts      # HomeKit services, state management
└── api-client.ts     # PGA IoT API client
```

### HomeKit Services

| Feature | Service | Notes |
|---------|---------|-------|
| Fan | Fan v2 | 4 speed levels (25% steps) |
| Light | Lightbulb | Brightness + color temperature |
| Filter | Filter Maintenance | Life %, change alert |
| Clean Air | AirPurifier | Periodic ventilation mode |
| Timer | Switch | Auto-off timer |
| Offline | StatusFault | Device unreachable detection |

### Known Firmware Quirks

1. Auto-light on fan start — plugin suppresses with immediate light-off
2. Auto-timer on fan start — plugin suppresses with intent flag for entire session
3. Stale cloud state — plugin clears timer state on fan-off to prevent reconciliation loop

## Deploy

1. `npm run build` locally
2. Push to `main`
3. Clone on UNRAID, `docker cp dist/` into `homebridge` container
4. Restart child bridge `0E:46:B4:3B:7E:12` via HomeKit MCP

## Key Rules

- **Public repo** — no Casa Lima infrastructure details, no internal IPs, no secrets
- `dist/` is committed (required for npm publish)
- Firmware workarounds are fragile — test thoroughly before modifying

## Skills

Read these skill files for domain expertise when relevant:

| Skill | Path | When to use |
|-------|------|-------------|
| Find Bugs | `~/Developer/atelier-skills/skills/find-bugs/SKILL.md` | Debugging firmware quirks |
| TDD | `~/Developer/atelier-skills/skills/test-driven-development/SKILL.md` | Writing tests |
| Code Review | `~/Developer/atelier-skills/skills/code-review/SKILL.md` | Reviewing changes |
| Git Workflow | `~/Developer/atelier-skills/skills/git-workflow/SKILL.md` | Branching, commits |

## Conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`
- Git branching: `feature/*` -> `develop` -> `main`
