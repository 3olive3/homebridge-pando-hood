# Changelog

All notable changes to this project are documented in this file.

## [1.1.9] - 2026-02-24

### Fixed
- Auto-timer suppression when fan speed changes trigger timer resets
- Tightened timer getter to avoid stale state reads

## [1.1.8] - 2026-02-24

### Fixed
- Increased auto-light suppression delay for reliable firmware timing

## [1.1.7] - 2026-02-24

### Added
- Device offline detection with `StatusFault` characteristic and command suppression

## [1.1.6] - 2026-02-24

### Fixed
- Push consistent fan state to HomeKit when hood is off

## [1.1.5] - 2026-02-24

### Fixed
- Prevent fan snap-back from HomeKit speed setter race condition

## [1.1.4] - 2026-02-24

### Fixed
- Push initial state to HomeKit on startup
- Remove conflicting timer migration logic

## [1.1.3] - 2026-02-24

### Changed
- Added plugin icon for Homebridge UI
- Fixed author display in config schema

## [1.1.2] - 2026-02-24

### Fixed
- Add command debouncing and polling cooldown to prevent rapid-fire API calls
- Revert timer from Valve back to Switch for better HomeKit compatibility

## [1.1.1] - 2026-02-24

### Fixed
- Clamp characteristic values to valid ranges on startup to prevent HomeKit errors

## [1.1.0] - 2026-02-24

### Changed
- Upgrade timer from Switch to Valve service type (countdown display in Home app)
- Upgrade clean air mode from Switch to AirPurifier service type

## [1.0.0] - 2026-02-24

Initial public release.

### Features
- Fan control with 4-speed mapping (off, low, medium, high, boost)
- Light control with on/off and color temperature (warm/cool)
- Filter maintenance sensor with reset capability
- Clean air mode (AirPurifier service)
- Auto-off timer (Switch service)
- Auto-light suppression when turning on fan via HomeKit
- PGA IoT cloud API integration with polling and command debouncing

### Fixed
- Service subtype registration and cache serialization
- REST command endpoint aligned with real PGA IoT API
- Prepare script for GitHub-based installs
