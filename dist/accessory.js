"use strict";
/**
 * PandoHoodAccessory
 *
 * Maps a single Pando kitchen hood to HomeKit services.
 *
 * Services exposed:
 *  - Fanv2              — hood fan on/off + speed (4 levels)
 *  - Lightbulb          — light on/off, brightness, color temperature
 *  - FilterMaintenance  — filter life level + change indication
 *  - AirPurifier        — clean air periodic ventilation mode
 *  - Valve (Generic)    — hood timer with duration countdown (1 min – 2 hr)
 *
 * The Pando app capabilities are fully replicated:
 *  - Fan:       device.onOff, device.fanSpeed (0-4)
 *  - Light:     device.lightOnOff, device.lightBrightness (10-100), device.lightColorTemperature (2700-6000K)
 *  - Filter:    device.filter1Value (0-360000s remaining), device.filter1.worn (0/1)
 *  - Timer:     device.timer.enable, device.timer.active, device.timerValue (60-7200s)
 *  - Clean Air: device.cleanAirEnabled
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PandoHoodAccessory = void 0;
const api_client_1 = require("./api-client");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Convert Kelvin color temperature to mireds (HomeKit unit). */
function kelvinToMireds(kelvin) {
    return Math.round(1_000_000 / kelvin);
}
/** Convert mireds to Kelvin. */
function miredsToKelvin(mireds) {
    return Math.round(1_000_000 / mireds);
}
/**
 * Map Pando fan speed (0-4) to HomeKit percentage (0-100).
 * Speed 0 = 0%, 1 = 25%, 2 = 50%, 3 = 75%, 4 = 100%.
 */
function fanSpeedToPercent(speed) {
    return Math.round((speed / 4) * 100);
}
/**
 * Map HomeKit percentage (0-100) to Pando fan speed (0-4).
 * Uses nearest level with a bias toward the lower level to avoid
 * accidentally bumping to max.
 */
function percentToFanSpeed(percent) {
    if (percent <= 0) {
        return 0;
    }
    return Math.min(4, Math.max(1, Math.round(percent / 25)));
}
// Default timer duration when enabling via HomeKit (15 minutes).
const DEFAULT_TIMER_DURATION = 900;
// Timer range (from Pando API metadata).
const TIMER_MIN = 60; // 1 minute
const TIMER_MAX = 7200; // 2 hours
// ---------------------------------------------------------------------------
// Accessory
// ---------------------------------------------------------------------------
class PandoHoodAccessory {
    platform;
    accessory;
    thingId;
    // Services
    fanService;
    lightService;
    filterService;
    cleanAirService;
    timerService;
    infoService;
    // Last-known state (populated by polling)
    state = {};
    constructor(platform, accessory, thing) {
        this.platform = platform;
        this.accessory = accessory;
        this.thingId = thing.uid;
        this.state = { ...thing.capabilities };
        const Characteristic = this.platform.api.hap.Characteristic;
        const Service = this.platform.api.hap.Service;
        // ---- Migration: remove old Switch services from v1.0.0 ---------------
        // v1.0.0 used Switch for Clean Air and Timer. v2 uses AirPurifier and
        // Valve. Remove the stale cached services so they don't linger.
        const oldCleanAirSwitch = accessory.getServiceById(Service.Switch, "clean-air");
        if (oldCleanAirSwitch) {
            platform.log.info("[%s] Removing old Switch (clean-air) — migrated to AirPurifier", thing.uid);
            accessory.removeService(oldCleanAirSwitch);
        }
        const oldTimerSwitch = accessory.getServiceById(Service.Switch, "timer");
        if (oldTimerSwitch) {
            platform.log.info("[%s] Removing old Switch (timer) — migrated to Valve", thing.uid);
            accessory.removeService(oldTimerSwitch);
        }
        // ---- Accessory Information -------------------------------------------
        this.infoService = accessory.getService(Service.AccessoryInformation)
            ?? accessory.addService(Service.AccessoryInformation);
        this.infoService
            .setCharacteristic(Characteristic.Manufacturer, "Pando")
            .setCharacteristic(Characteristic.Model, (0, api_client_1.getThingDisplayName)(thing))
            .setCharacteristic(Characteristic.SerialNumber, thing.uid)
            .setCharacteristic(Characteristic.FirmwareRevision, (0, api_client_1.getMetaProp)(thing, "property.device.fw.version") ?? "1.0");
        // ---- Fan (Fanv2) ----------------------------------------------------
        this.fanService = accessory.getServiceById(Service.Fanv2, "fan")
            ?? accessory.addService(Service.Fanv2, "Hood Fan", "fan");
        this.fanService.setCharacteristic(Characteristic.Name, "Hood Fan");
        if (Characteristic.ConfiguredName) {
            this.fanService.setCharacteristic(Characteristic.ConfiguredName, "Hood Fan");
        }
        this.fanService.getCharacteristic(Characteristic.Active)
            .onGet(() => this.getFanActive())
            .onSet((value) => this.setFanActive(value));
        this.fanService.getCharacteristic(Characteristic.RotationSpeed)
            .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
            .onGet(() => this.getFanSpeed())
            .onSet((value) => this.setFanSpeed(value));
        // ---- Lightbulb ------------------------------------------------------
        this.lightService = accessory.getServiceById(Service.Lightbulb, "light")
            ?? accessory.addService(Service.Lightbulb, "Hood Light", "light");
        this.lightService.setCharacteristic(Characteristic.Name, "Hood Light");
        if (Characteristic.ConfiguredName) {
            this.lightService.setCharacteristic(Characteristic.ConfiguredName, "Hood Light");
        }
        this.lightService.getCharacteristic(Characteristic.On)
            .onGet(() => this.getLightOn())
            .onSet((value) => this.setLightOn(value));
        this.lightService.getCharacteristic(Characteristic.Brightness)
            .setProps({ minValue: 10, maxValue: 100, minStep: 1 })
            .onGet(() => this.getLightBrightness())
            .onSet((value) => this.setLightBrightness(value));
        // Color temperature: 2700K-6000K -> mireds (167-370)
        this.lightService.getCharacteristic(Characteristic.ColorTemperature)
            .setProps({
            minValue: kelvinToMireds(6000), // ~167 mireds
            maxValue: kelvinToMireds(2700), // ~370 mireds
            minStep: 1,
        })
            .onGet(() => this.getLightColorTemperature())
            .onSet((value) => this.setLightColorTemperature(value));
        // ---- Filter Maintenance ---------------------------------------------
        this.filterService = accessory.getServiceById(Service.FilterMaintenance, "filter")
            ?? accessory.addService(Service.FilterMaintenance, "Filter", "filter");
        this.filterService.setCharacteristic(Characteristic.Name, "Filter");
        this.filterService.getCharacteristic(Characteristic.FilterChangeIndication)
            .onGet(() => this.getFilterChangeIndication());
        this.filterService.getCharacteristic(Characteristic.FilterLifeLevel)
            .onGet(() => this.getFilterLifeLevel());
        // ---- Clean Air (Air Purifier) ---------------------------------------
        this.cleanAirService = accessory.getServiceById(Service.AirPurifier, "clean-air")
            ?? accessory.addService(Service.AirPurifier, "Clean Air", "clean-air");
        this.cleanAirService.setCharacteristic(Characteristic.Name, "Clean Air");
        if (Characteristic.ConfiguredName) {
            this.cleanAirService.setCharacteristic(Characteristic.ConfiguredName, "Clean Air");
        }
        this.cleanAirService.getCharacteristic(Characteristic.Active)
            .onGet(() => this.getCleanAirActive())
            .onSet((value) => this.setCleanAirActive(value));
        this.cleanAirService.getCharacteristic(Characteristic.CurrentAirPurifierState)
            .onGet(() => this.getCleanAirCurrentState());
        this.cleanAirService.getCharacteristic(Characteristic.TargetAirPurifierState)
            .setProps({ validValues: [1] }) // Only "Auto" mode — Clean Air is always automatic
            .updateValue(1) // Set initial value to Auto before any cache reads
            .onGet(() => 1) // Always return Auto
            .onSet(() => { }); // No-op — can't change mode
        // ---- Timer (Valve - Generic) ----------------------------------------
        this.timerService = accessory.getServiceById(Service.Valve, "timer")
            ?? accessory.addService(Service.Valve, "Timer", "timer");
        this.timerService.setCharacteristic(Characteristic.Name, "Timer");
        if (Characteristic.ConfiguredName) {
            this.timerService.setCharacteristic(Characteristic.ConfiguredName, "Timer");
        }
        // ValveType 0 = Generic
        this.timerService.setCharacteristic(Characteristic.ValveType, 0);
        this.timerService.getCharacteristic(Characteristic.Active)
            .onGet(() => this.getTimerActive())
            .onSet((value) => this.setTimerActive(value));
        this.timerService.getCharacteristic(Characteristic.InUse)
            .onGet(() => this.getTimerInUse());
        this.timerService.getCharacteristic(Characteristic.SetDuration)
            .setProps({ minValue: TIMER_MIN, maxValue: TIMER_MAX, minStep: 60 })
            .onGet(() => this.getTimerDuration())
            .onSet((value) => this.setTimerDuration(value));
        this.timerService.getCharacteristic(Characteristic.RemainingDuration)
            .setProps({ minValue: 0, maxValue: TIMER_MAX })
            .onGet(() => this.getTimerRemaining());
        // ---- Service linking -------------------------------------------------
        // Mark fan as the primary service. Link the light and filter to the fan
        // so HomeKit knows they belong together.
        this.fanService.setPrimaryService(true);
        this.fanService.addLinkedService(this.lightService);
        this.fanService.addLinkedService(this.filterService);
    }
    // ---- State update (called by platform polling) -------------------------
    updateState(thing) {
        this.state = { ...thing.capabilities };
        const Characteristic = this.platform.api.hap.Characteristic;
        // Push updated values to HomeKit so the Home app reflects real-time state.
        this.fanService.updateCharacteristic(Characteristic.Active, this.getFanActive());
        this.fanService.updateCharacteristic(Characteristic.RotationSpeed, this.getFanSpeed());
        this.lightService.updateCharacteristic(Characteristic.On, this.getLightOn());
        this.lightService.updateCharacteristic(Characteristic.Brightness, this.getLightBrightness());
        this.lightService.updateCharacteristic(Characteristic.ColorTemperature, this.getLightColorTemperature());
        this.filterService.updateCharacteristic(Characteristic.FilterChangeIndication, this.getFilterChangeIndication());
        this.filterService.updateCharacteristic(Characteristic.FilterLifeLevel, this.getFilterLifeLevel());
        this.cleanAirService.updateCharacteristic(Characteristic.Active, this.getCleanAirActive());
        this.cleanAirService.updateCharacteristic(Characteristic.CurrentAirPurifierState, this.getCleanAirCurrentState());
        this.timerService.updateCharacteristic(Characteristic.Active, this.getTimerActive());
        this.timerService.updateCharacteristic(Characteristic.InUse, this.getTimerInUse());
        this.timerService.updateCharacteristic(Characteristic.RemainingDuration, this.getTimerRemaining());
    }
    // ---- Fan handlers ------------------------------------------------------
    getFanActive() {
        return (this.state["device.onOff"] ?? 0) ? 1 : 0;
    }
    async setFanActive(value) {
        const active = value;
        this.platform.log.info("[%s] Set fan active: %d", this.thingId, active);
        // Remember light state before turning on the hood — the hood firmware
        // turns the light on at default brightness whenever device.onOff goes to 1.
        const lightWasOff = !this.state["device.lightOnOff"];
        this.state["device.onOff"] = active;
        await this.platform.client.sendCommand(this.thingId, {
            "device.onOff": active,
        });
        // If we just turned on the hood and the light was off, tell the hood to
        // turn the light back off so the fan doesn't drag the light along.
        if (active === 1 && lightWasOff) {
            this.platform.log.info("[%s] Suppressing auto-light (was off before fan on)", this.thingId);
            await this.platform.client.sendCommand(this.thingId, {
                "device.lightOnOff": 0,
            });
        }
    }
    getFanSpeed() {
        return fanSpeedToPercent(this.state["device.fanSpeed"] ?? 0);
    }
    async setFanSpeed(value) {
        const percent = value;
        const speed = percentToFanSpeed(percent);
        this.platform.log.info("[%s] Set fan speed: %d%% -> level %d", this.thingId, percent, speed);
        this.state["device.fanSpeed"] = speed;
        // Remember light state before turning on the hood — the hood firmware
        // turns the light on at default brightness whenever device.onOff goes to 1.
        const needsOnOff = speed > 0 && !this.state["device.onOff"];
        const lightWasOff = !this.state["device.lightOnOff"];
        // If setting speed > 0, also turn on the hood.
        const commands = { "device.fanSpeed": speed };
        if (needsOnOff) {
            commands["device.onOff"] = 1;
            this.state["device.onOff"] = 1;
        }
        await this.platform.client.sendCommand(this.thingId, commands);
        // If we just turned on the hood and the light was off, suppress the
        // hood's automatic light-on behavior.
        if (needsOnOff && lightWasOff) {
            this.platform.log.info("[%s] Suppressing auto-light (was off before fan on)", this.thingId);
            await this.platform.client.sendCommand(this.thingId, {
                "device.lightOnOff": 0,
            });
        }
    }
    // ---- Light handlers ----------------------------------------------------
    getLightOn() {
        return (this.state["device.lightOnOff"] ?? 0) === 1;
    }
    async setLightOn(value) {
        const on = value ? 1 : 0;
        this.platform.log.info("[%s] Set light on: %d", this.thingId, on);
        this.state["device.lightOnOff"] = on;
        await this.platform.client.sendCommand(this.thingId, {
            "device.lightOnOff": on,
        });
    }
    getLightBrightness() {
        // Clamp to minValue 10 — when light is off the hood reports 0.
        return Math.max(10, this.state["device.lightBrightness"] ?? 100);
    }
    async setLightBrightness(value) {
        const brightness = Math.max(10, Math.min(100, value));
        this.platform.log.info("[%s] Set light brightness: %d%%", this.thingId, brightness);
        this.state["device.lightBrightness"] = brightness;
        await this.platform.client.sendCommand(this.thingId, {
            "device.lightBrightness": brightness,
        });
    }
    getLightColorTemperature() {
        const kelvin = this.state["device.lightColorTemperature"] ?? 2700;
        const clamped = Math.max(2700, Math.min(6000, kelvin));
        // Clamp mireds to characteristic range (167-370).
        return Math.max(kelvinToMireds(6000), Math.min(kelvinToMireds(2700), kelvinToMireds(clamped)));
    }
    async setLightColorTemperature(value) {
        const mireds = value;
        const kelvin = Math.max(2700, Math.min(6000, miredsToKelvin(mireds)));
        this.platform.log.info("[%s] Set light color temperature: %d mireds -> %dK", this.thingId, mireds, kelvin);
        this.state["device.lightColorTemperature"] = kelvin;
        await this.platform.client.sendCommand(this.thingId, {
            "device.lightColorTemperature": kelvin,
        });
    }
    // ---- Filter handlers ---------------------------------------------------
    getFilterChangeIndication() {
        // 0 = filter OK, 1 = filter needs change
        return (this.state["device.filter1.worn"] ?? 0) === 1 ? 1 : 0;
    }
    getFilterLifeLevel() {
        // filter1Value is remaining time in seconds, max 360000 (100 hours).
        // HomeKit expects 0-100 percentage.
        const remaining = this.state["device.filter1Value"] ?? 0;
        const max = 360000;
        return Math.round((remaining / max) * 100);
    }
    // ---- Clean Air handlers (Air Purifier) ---------------------------------
    getCleanAirActive() {
        return (this.state["device.cleanAirEnabled"] ?? 0) === 1 ? 1 : 0;
    }
    getCleanAirCurrentState() {
        // 0 = Inactive, 1 = Idle, 2 = Purifying Air
        const enabled = this.state["device.cleanAirEnabled"] ?? 0;
        return enabled === 1 ? 2 : 0;
    }
    async setCleanAirActive(value) {
        const active = value === 1 ? 1 : 0;
        this.platform.log.info("[%s] Set clean air: %d", this.thingId, active);
        this.state["device.cleanAirEnabled"] = active;
        await this.platform.client.sendCommand(this.thingId, {
            "device.cleanAirEnabled": active,
        });
    }
    // ---- Timer handlers (Valve) --------------------------------------------
    getTimerActive() {
        // Active if either enabled or actively running.
        const enabled = this.state["device.timer.enable"] ?? 0;
        const active = this.state["device.timer.active"] ?? 0;
        return (enabled === 1 || active === 1) ? 1 : 0;
    }
    getTimerInUse() {
        // InUse = timer is actively counting down.
        return (this.state["device.timer.active"] ?? 0) === 1 ? 1 : 0;
    }
    getTimerDuration() {
        // Return the configured timer duration, clamped to valid range.
        // When inactive the hood reports 0 — clamp to TIMER_MIN (minValue).
        const value = this.state["device.timerValue"] ?? DEFAULT_TIMER_DURATION;
        return Math.max(TIMER_MIN, Math.min(TIMER_MAX, value || DEFAULT_TIMER_DURATION));
    }
    getTimerRemaining() {
        // When the timer is active, timerValue holds the remaining seconds.
        // When inactive, return 0.
        const active = this.state["device.timer.active"] ?? 0;
        if (active !== 1) {
            return 0;
        }
        return Math.max(0, Math.min(TIMER_MAX, this.state["device.timerValue"] ?? 0));
    }
    async setTimerDuration(value) {
        const duration = Math.max(TIMER_MIN, Math.min(TIMER_MAX, value));
        this.platform.log.info("[%s] Set timer duration: %ds", this.thingId, duration);
        this.state["device.timerValue"] = duration;
        await this.platform.client.sendCommand(this.thingId, {
            "device.timerValue": duration,
        });
    }
    async setTimerActive(value) {
        const active = value === 1 ? 1 : 0;
        this.platform.log.info("[%s] Set timer: %d", this.thingId, active);
        if (active === 1) {
            // When enabling, also send the duration to ensure the hood has a value.
            const duration = this.state["device.timerValue"] ?? DEFAULT_TIMER_DURATION;
            this.state["device.timer.enable"] = 1;
            this.state["device.timerValue"] = duration;
            await this.platform.client.sendCommand(this.thingId, {
                "device.timer.enable": 1,
                "device.timerValue": duration,
            });
        }
        else {
            this.state["device.timer.enable"] = 0;
            await this.platform.client.sendCommand(this.thingId, {
                "device.timer.enable": 0,
            });
        }
    }
}
exports.PandoHoodAccessory = PandoHoodAccessory;
//# sourceMappingURL=accessory.js.map