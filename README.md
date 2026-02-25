<p align="center">
  <img src="logo.png" alt="Pando" width="300">
</p>

# homebridge-pando-hood

Homebridge plugin for [Pando](https://www.pando.es/) kitchen hoods with AirLink Wi-Fi connectivity. Brings your Pando hood into Apple HomeKit with full control over fan, light, filter monitoring, and more.

## Features

This plugin replicates **all** Pando app functionality in HomeKit:

| Feature | HomeKit Service | Controls |
|---------|----------------|----------|
| **Fan** | Fan v2 | On/off, 4 speed levels (25% steps) |
| **Light** | Lightbulb | On/off, brightness (10-100%), color temperature (2700-6000K) |
| **Filter** | Filter Maintenance | Filter life percentage, change needed alert |
| **Clean Air** | AirPurifier | Toggle periodic ventilation mode |
| **Timer** | Switch | Toggle hood auto-off timer |
| **Offline Detection** | StatusFault | Marks accessory as faulted when device stops responding |

All hoods linked to your Pando account are discovered automatically.

## Requirements

- [Homebridge](https://homebridge.io/) >= 1.6.0
- Node.js >= 18
- A Pando hood with AirLink Wi-Fi (connected via the [Pando app](https://www.pando.es/tecnologia21/#airlink))
- A Pando account (the email/password you use in the Pando app)

## Installation

### Via Homebridge UI (recommended)

1. Open the Homebridge UI
2. Go to **Plugins** tab
3. Search for `homebridge-pando-hood`
4. Click **Install**
5. Configure your Pando credentials in the plugin settings

### Via npm

```bash
npm install -g homebridge-pando-hood
```

Then add the platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "PandoHood",
      "name": "Pando Hood",
      "username": "your-pando-email@example.com",
      "password": "your-pando-password",
      "pollingInterval": 30
    }
  ]
}
```

## Configuration

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `platform` | Yes | `"PandoHood"` | Must be `"PandoHood"` |
| `name` | Yes | `"Pando Hood"` | Display name in Homebridge logs |
| `username` | Yes | — | Your Pando account email |
| `password` | Yes | — | Your Pando account password |
| `pollingInterval` | No | `30` | State polling interval in seconds (min: 10, max: 300) |

## How It Works

This plugin communicates with the PGA IoT cloud platform (`pando.iotpga.it`) — the same backend used by the official Pando app. It authenticates with your Pando credentials, discovers your hoods, and polls for state updates at a configurable interval.

**Cloud dependency**: This plugin requires an internet connection to control your hood. There is no local API available on the device.

### Fan Speed Mapping

The hood has 4 discrete speed levels. HomeKit maps these to percentages:

| HomeKit | Pando Speed |
|---------|------------|
| 0% | Off |
| 25% | Speed 1 |
| 50% | Speed 2 |
| 75% | Speed 3 |
| 100% | Speed 4 |

### Color Temperature

The hood light supports color temperatures from 2700K (warm white) to 6000K (cool daylight). HomeKit displays this as the standard warm-to-cool color temperature slider.

### Firmware Quirks & Auto-Behavior

The Pando hood firmware has several auto-behaviors that the plugin works around:

- **Auto-light on fan start**: When the fan turns on, the firmware automatically enables the light. The plugin suppresses this by immediately sending a light-off command after fan-on (if the light was off before).
- **Auto-timer on fan start**: Similarly, the firmware auto-enables the timer when the fan turns on. The plugin suppresses this with an intent flag that stays active for the entire fan session.
- **Stale cloud state**: The PGA IoT cloud API can persist stale `timer.enable: 1` values even after the fan turns off. The plugin clears this locally on fan-off to prevent HomeKit from seeing a phantom state change.

These workarounds are transparent to the user — the hood behaves as expected in HomeKit.

## Supported Models

This plugin should work with any Pando hood that has AirLink Wi-Fi connectivity and uses the Pando app. Known compatible models include:

- Pando E-297
- Other AirLink-enabled Pando hoods

If you have a Pando hood that works (or doesn't), please [open an issue](https://github.com/3olive3/homebridge-pando-hood/issues) to help build the compatibility list.

## Troubleshooting

### "Pando account credentials are required"
Make sure you've configured both `username` and `password` in the plugin settings.

### Hood shows as "Not Responding"
- Check that your hood is connected to Wi-Fi (verify in the Pando app first)
- Check the Homebridge logs for authentication errors
- The hood must be powered on and connected to the internet

### Commands don't seem to work
- The hood processes commands via the cloud — there may be a 1-2 second delay
- If the hood is offline (powered off or disconnected from Wi-Fi), commands will queue but won't execute until it reconnects

### Token expired errors
The plugin automatically re-authenticates when the token expires (every 4 hours). If you see persistent auth errors, verify your credentials are still valid in the Pando app.

## Development

```bash
# Clone
git clone https://github.com/3olive3/homebridge-pando-hood.git
cd homebridge-pando-hood

# Install dependencies
npm install

# Build
npm run build

# Link for local testing
npm link
```

## License

MIT

## Disclaimer

This plugin is not affiliated with, endorsed by, or connected to Pando or PGA2.0 S.R.L. in any way. It is an independent, community-developed project that interacts with the publicly available PGA IoT API. Use at your own risk.
