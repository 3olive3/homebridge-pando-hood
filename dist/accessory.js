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
 *  - Switch             — hood timer on/off
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
// Debounce helper
// ---------------------------------------------------------------------------
/**
 * Debounced command sender. Coalesces rapid characteristic changes (e.g.,
 * HomeKit slider firing 0→25→50→75→100 within the same second) into a
 * single API call with only the final values.
 */
class CommandDebouncer {
    pending = {};
    timer = null;
    delayMs;
    send;
    constructor(delayMs, send) {
        this.delayMs = delayMs;
        this.send = send;
    }
    /** Queue parameters to be sent. Values for the same key are overwritten. */
    enqueue(params) {
        Object.assign(this.pending, params);
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
    async flush() {
        this.timer = null;
        const params = { ...this.pending };
        this.pending = {};
        if (Object.keys(params).length === 0) {
            return;
        }
        await this.send(params);
    }
}
// Debounce window: 500ms — coalesces rapid HomeKit slider changes.
const DEBOUNCE_MS = 500;
// After a command is sent, ignore polling updates for this many ms.
const COMMAND_COOLDOWN_MS = 3000;
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
    // Last non-zero fan speed — used to restore speed when turning ON via HomeKit.
    // This is kept separate because getFanSpeed() returns 0 when the hood is OFF
    // (to give HomeKit a consistent Active=0 + Speed=0 pair and prevent snap-back).
    lastFanSpeed = 1;
    // Command debouncer — coalesces rapid set handler calls into one API call.
    debouncer;
    // Cooldown: after sending a command, skip polling updates until this time.
    commandCooldownUntil = 0;
    // Auto-suppression intent flags. Set when the fan turns on and the light/timer
    // was off beforehand. The pending setTimeout checks these flags (not this.state)
    // to decide whether to fire the suppression command — because this.state gets
    // overwritten by polling during the command cooldown window, which would falsely
    // cancel the suppression. Cleared after suppression fires, or when the user
    // explicitly enables the light/timer via HomeKit (cancelling the suppression).
    suppressAutoLight = false;
    suppressAutoTimer = false;
    // Online status — set by the platform when consecutive poll failures exceed threshold.
    // When offline, commands are suppressed and StatusFault is set on the fan service.
    online = true;
    constructor(platform, accessory, thing) {
        this.platform = platform;
        this.accessory = accessory;
        this.thingId = thing.uid;
        this.state = { ...thing.capabilities };
        // Seed lastFanSpeed from the device's current fan speed (if non-zero).
        const initialSpeed = thing.capabilities["device.fanSpeed"] ?? 0;
        if (initialSpeed > 0) {
            this.lastFanSpeed = initialSpeed;
        }
        // Create debouncer — coalesces rapid HomeKit changes into one API call.
        this.debouncer = new CommandDebouncer(DEBOUNCE_MS, async (params) => {
            // Suppress commands when device is known to be offline.
            if (!this.online) {
                this.platform.log.warn("[%s] Suppressing command (device offline): %s", this.thingId, JSON.stringify(params));
                return;
            }
            this.commandCooldownUntil = Date.now() + COMMAND_COOLDOWN_MS;
            this.platform.log.info("[%s] Sending debounced command: %s", this.thingId, JSON.stringify(params));
            await this.platform.client.sendCommand(this.thingId, params);
        });
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
        // v2.0.0 used Valve for Timer — shows water tap icon in Apple Home.
        // v2.1.0 reverts to Switch for a correct icon.
        const oldTimerValve = accessory.getServiceById(Service.Valve, "timer");
        if (oldTimerValve) {
            platform.log.info("[%s] Removing old Valve (timer) — reverted to Switch", thing.uid);
            accessory.removeService(oldTimerValve);
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
        // StatusFault — signals "Not Responding" in HomeKit when cloud API is unreachable.
        this.fanService.getCharacteristic(Characteristic.StatusFault)
            .onGet(() => this.online
            ? Characteristic.StatusFault.NO_FAULT
            : Characteristic.StatusFault.GENERAL_FAULT);
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
        // ---- Timer (Switch) ---------------------------------------------------
        // Using Switch instead of Valve to avoid Apple Home's water tap icon.
        this.timerService = accessory.getServiceById(Service.Switch, "timer")
            ?? accessory.addService(Service.Switch, "Timer", "timer");
        this.timerService.setCharacteristic(Characteristic.Name, "Timer");
        if (Characteristic.ConfiguredName) {
            this.timerService.setCharacteristic(Characteristic.ConfiguredName, "Timer");
        }
        this.timerService.getCharacteristic(Characteristic.On)
            .onGet(() => this.getTimerOn())
            .onSet((value) => this.setTimerActive(value));
        // ---- Service linking -------------------------------------------------
        // Mark fan as the primary service. Link the light and filter to the fan
        // so HomeKit knows they belong together.
        this.fanService.setPrimaryService(true);
        this.fanService.addLinkedService(this.lightService);
        this.fanService.addLinkedService(this.filterService);
        // ---- Push initial state from API ------------------------------------
        // The cached accessory may have stale characteristic values from before
        // the last restart/pairing. Push the real API state immediately so
        // HomeKit reflects the actual hood state from the start.
        this.pushStateToHomeKit();
    }
    // ---- State update (called by platform polling) -------------------------
    updateState(thing) {
        // Command cooldown: skip pushing values to HomeKit if we recently sent
        // a command. This prevents the polling loop from overwriting the user's
        // intended state with stale cloud data before the device settles.
        if (Date.now() < this.commandCooldownUntil) {
            this.platform.log.debug("[%s] Skipping poll update — command cooldown active (%dms remaining)", this.thingId, this.commandCooldownUntil - Date.now());
            // Still update internal state so getters return fresh data on next read.
            this.state = { ...thing.capabilities };
            return;
        }
        this.state = { ...thing.capabilities };
        // Keep lastFanSpeed in sync with polled data (e.g., speed changed via Pando app).
        const polledSpeed = thing.capabilities["device.fanSpeed"] ?? 0;
        if (polledSpeed > 0) {
            this.lastFanSpeed = polledSpeed;
        }
        this.pushStateToHomeKit();
    }
    /**
     * Set the online/offline status of this accessory.
     * Called by the platform when consecutive poll failures cross the threshold.
     * When offline: StatusFault = GENERAL_FAULT, commands are suppressed.
     * When online:  StatusFault = NO_FAULT, normal operation resumes.
     */
    setOnline(online) {
        if (this.online === online) {
            return; // No state change
        }
        this.online = online;
        const Characteristic = this.platform.api.hap.Characteristic;
        if (online) {
            this.platform.log.info("[%s] Device is back online — clearing fault status.", this.thingId);
            this.fanService.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT);
        }
        else {
            this.platform.log.warn("[%s] Device marked offline — setting fault status.", this.thingId);
            this.fanService.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
        }
    }
    /** Push current internal state to HomeKit characteristics. */
    pushStateToHomeKit() {
        const Characteristic = this.platform.api.hap.Characteristic;
        // Push updated values to HomeKit so the Home app reflects real-time state.
        this.fanService.updateCharacteristic(Characteristic.Active, this.getFanActive());
        this.fanService.updateCharacteristic(Characteristic.RotationSpeed, this.getFanSpeed());
        this.fanService.updateCharacteristic(Characteristic.StatusFault, this.online
            ? Characteristic.StatusFault.NO_FAULT
            : Characteristic.StatusFault.GENERAL_FAULT);
        this.lightService.updateCharacteristic(Characteristic.On, this.getLightOn());
        this.lightService.updateCharacteristic(Characteristic.Brightness, this.getLightBrightness());
        this.lightService.updateCharacteristic(Characteristic.ColorTemperature, this.getLightColorTemperature());
        this.filterService.updateCharacteristic(Characteristic.FilterChangeIndication, this.getFilterChangeIndication());
        this.filterService.updateCharacteristic(Characteristic.FilterLifeLevel, this.getFilterLifeLevel());
        this.cleanAirService.updateCharacteristic(Characteristic.Active, this.getCleanAirActive());
        this.cleanAirService.updateCharacteristic(Characteristic.CurrentAirPurifierState, this.getCleanAirCurrentState());
        this.timerService.updateCharacteristic(Characteristic.On, this.getTimerOn());
    }
    // ---- Fan handlers ------------------------------------------------------
    getFanActive() {
        return (this.state["device.onOff"] ?? 0) ? 1 : 0;
    }
    async setFanActive(value) {
        const active = value;
        this.platform.log.info("[%s] Set fan active: %d", this.thingId, active);
        // Remember light and timer state before turning on the hood — the hood
        // firmware turns the light on at default brightness and sets timer.enable
        // whenever device.onOff goes to 1.
        const lightWasOff = !this.state["device.lightOnOff"];
        // The cloud API may persist timer.enable: 1 even after the hood is turned
        // off (stale state from the last run). When the fan is currently OFF, the
        // timer is logically off regardless of what the cloud reports — so always
        // treat it as "was off" to ensure suppression fires on the next fan-on.
        const fanIsCurrentlyOff = !this.state["device.onOff"];
        const timerWasOff = fanIsCurrentlyOff || !this.state["device.timer.enable"];
        this.state["device.onOff"] = active;
        // When turning OFF, clear auto-suppression flags — the session is over.
        // On the next fan-on, fresh flags will be set based on current state.
        // Also force timer state to 0 so HomeKit doesn't see a stale timer.enable:1
        // from the cloud and fire a spurious setTimerActive(OFF) during shutdown.
        if (active === 0) {
            this.suppressAutoLight = false;
            this.suppressAutoTimer = false;
            this.state["device.timer.enable"] = 0;
        }
        // When turning ON, include the last-used fan speed so the hood starts at
        // the right level. We use lastFanSpeed because state["device.fanSpeed"]
        // may be 0 (we clear it for HomeKit consistency when OFF).
        const commands = { "device.onOff": active };
        if (active === 1) {
            const speed = this.lastFanSpeed;
            commands["device.fanSpeed"] = speed;
            this.state["device.fanSpeed"] = speed;
        }
        this.debouncer.enqueue(commands);
        // Auto-light suppression: if turning on and light was off, schedule a
        // direct (non-debounced) follow-up command after the debounce window
        // fires, to turn the light back off.
        if (active === 1 && lightWasOff) {
            this.suppressAutoLight = true;
            setTimeout(async () => {
                // Only suppress if the flag is still set — it gets cleared if the
                // user explicitly turns the light ON via HomeKit before this fires.
                if (this.suppressAutoLight) {
                    this.suppressAutoLight = false;
                    if (!this.online) {
                        this.platform.log.warn("[%s] Skipping auto-light suppression (device offline)", this.thingId);
                        return;
                    }
                    this.platform.log.info("[%s] Suppressing auto-light (was off before fan on)", this.thingId);
                    this.commandCooldownUntil = Date.now() + COMMAND_COOLDOWN_MS;
                    await this.platform.client.sendCommand(this.thingId, {
                        "device.lightOnOff": 0,
                    });
                }
            }, DEBOUNCE_MS + 1500); // Fire well after the hood firmware processes fan-on and auto-lights
        }
        // Auto-timer suppression: the hood firmware sets timer.enable and/or
        // timer.active when device.onOff goes to 1. If we don't counteract this,
        // the next poll will push Timer=ON to HomeKit, triggering setTimerActive()
        // which sends timer.enable:1 + timerValue:0 back to the API — a feedback
        // loop identical to the auto-light bug.
        if (active === 1 && timerWasOff) {
            this.suppressAutoTimer = true;
            setTimeout(async () => {
                // Only suppress if the flag is still set — it gets cleared if the
                // user explicitly turns the timer ON via HomeKit before this fires.
                if (this.suppressAutoTimer) {
                    // NOTE: Do NOT clear suppressAutoTimer here. The firmware will
                    // re-assert timer.enable: 1 on subsequent polls for as long as
                    // the fan runs. The flag stays active for the entire fan session
                    // and is checked in getTimerOn() to filter firmware state from
                    // HomeKit. It is cleared when: (a) user explicitly enables timer,
                    // or (b) fan is turned off.
                    if (!this.online) {
                        this.platform.log.warn("[%s] Skipping auto-timer suppression (device offline)", this.thingId);
                        return;
                    }
                    this.platform.log.info("[%s] Suppressing auto-timer (was off before fan on)", this.thingId);
                    this.commandCooldownUntil = Date.now() + COMMAND_COOLDOWN_MS;
                    await this.platform.client.sendCommand(this.thingId, {
                        "device.timer.enable": 0,
                    });
                }
            }, DEBOUNCE_MS + 1500); // Same timing as auto-light — fire after firmware settles
        }
    }
    getFanSpeed() {
        // When the hood is OFF, always report speed as 0 to HomeKit.
        // This ensures HomeKit sees a consistent Active=0 + Speed=0 pair and
        // does NOT "reconcile" by firing set handlers to turn the fan back on.
        if (!this.state["device.onOff"]) {
            return 0;
        }
        return fanSpeedToPercent(this.state["device.fanSpeed"] ?? 0);
    }
    async setFanSpeed(value) {
        const percent = value;
        const speed = percentToFanSpeed(percent);
        this.platform.log.info("[%s] Set fan speed: %d%% -> level %d", this.thingId, percent, speed);
        // Always update local state so setFanActive() can read the latest speed.
        this.state["device.fanSpeed"] = speed;
        // Track last non-zero speed for restoration when turning ON from OFF.
        if (speed > 0) {
            this.lastFanSpeed = speed;
        }
        // Only send the speed command if the hood is already ON.
        // When the hood is OFF and HomeKit fires RotationSpeed (snap-back artifact
        // from toggling Active), we just update state silently — setFanActive()
        // handles the actual turn-on and includes the speed in its command.
        if (!this.state["device.onOff"]) {
            this.platform.log.debug("[%s] Hood is off — storing speed %d without sending command", this.thingId, speed);
            return;
        }
        this.debouncer.enqueue({ "device.fanSpeed": speed });
    }
    // ---- Light handlers ----------------------------------------------------
    getLightOn() {
        return (this.state["device.lightOnOff"] ?? 0) === 1;
    }
    async setLightOn(value) {
        const on = value ? 1 : 0;
        this.platform.log.info("[%s] Set light on: %d", this.thingId, on);
        // If the user explicitly turns the light on, cancel any pending
        // auto-light suppression — they want the light on.
        if (on) {
            this.suppressAutoLight = false;
        }
        this.state["device.lightOnOff"] = on;
        this.debouncer.enqueue({ "device.lightOnOff": on });
    }
    getLightBrightness() {
        // Clamp to minValue 10 — when light is off the hood reports 0.
        return Math.max(10, this.state["device.lightBrightness"] ?? 100);
    }
    async setLightBrightness(value) {
        const brightness = Math.max(10, Math.min(100, value));
        this.platform.log.info("[%s] Set light brightness: %d%%", this.thingId, brightness);
        this.state["device.lightBrightness"] = brightness;
        this.debouncer.enqueue({ "device.lightBrightness": brightness });
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
        this.debouncer.enqueue({ "device.lightColorTemperature": kelvin });
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
        this.debouncer.enqueue({ "device.cleanAirEnabled": active });
    }
    // ---- Timer handlers (Switch) --------------------------------------------
    getTimerOn() {
        // When auto-timer suppression is active (fan was turned on with timer off),
        // always report OFF to HomeKit. The firmware automatically sets
        // timer.enable: 1 when the fan runs, and re-asserts it on every poll —
        // a one-shot API command can't keep up. Instead, we filter it here so
        // HomeKit never sees the firmware's auto-timer during a suppressed session.
        if (this.suppressAutoTimer) {
            return false;
        }
        // Only check "enable" — "active" is a firmware status flag that the hood
        // sets automatically when the fan turns on, causing a false-positive.
        const enabled = this.state["device.timer.enable"] ?? 0;
        return enabled === 1;
    }
    async setTimerActive(value) {
        const on = value ? 1 : 0;
        this.platform.log.info("[%s] Set timer: %s", this.thingId, on ? "ON" : "OFF");
        if (on) {
            // User explicitly enabled the timer — cancel any pending auto-suppression.
            this.suppressAutoTimer = false;
            // When enabling, also send the duration to ensure the hood has a value.
            // Use || (not ??) so that 0 also falls back to the default — the cloud
            // API may report timerValue: 0 after a firmware-initiated timer state.
            const duration = this.state["device.timerValue"] || DEFAULT_TIMER_DURATION;
            this.state["device.timer.enable"] = 1;
            this.state["device.timerValue"] = duration;
            this.debouncer.enqueue({
                "device.timer.enable": 1,
                "device.timerValue": duration,
            });
        }
        else {
            this.state["device.timer.enable"] = 0;
            this.debouncer.enqueue({ "device.timer.enable": 0 });
        }
    }
}
exports.PandoHoodAccessory = PandoHoodAccessory;
//# sourceMappingURL=accessory.js.map