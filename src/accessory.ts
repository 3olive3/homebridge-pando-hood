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

import {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from "homebridge";

import { PandoPlatform } from "./platform";
import { PgaThing, getThingDisplayName, getMetaProp } from "./api-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert Kelvin color temperature to mireds (HomeKit unit). */
function kelvinToMireds(kelvin: number): number {
  return Math.round(1_000_000 / kelvin);
}

/** Convert mireds to Kelvin. */
function miredsToKelvin(mireds: number): number {
  return Math.round(1_000_000 / mireds);
}

/**
 * Map Pando fan speed (0-4) to HomeKit percentage (0-100).
 * Speed 0 = 0%, 1 = 25%, 2 = 50%, 3 = 75%, 4 = 100%.
 */
function fanSpeedToPercent(speed: number): number {
  return Math.round((speed / 4) * 100);
}

/**
 * Map HomeKit percentage (0-100) to Pando fan speed (0-4).
 * Uses nearest level with a bias toward the lower level to avoid
 * accidentally bumping to max.
 */
function percentToFanSpeed(percent: number): number {
  if (percent <= 0) {
    return 0;
  }
  return Math.min(4, Math.max(1, Math.round(percent / 25)));
}

// Default timer duration when enabling via HomeKit (15 minutes).
const DEFAULT_TIMER_DURATION = 900;

// Timer range (from Pando API metadata).
const TIMER_MIN = 60;    // 1 minute
const TIMER_MAX = 7200;  // 2 hours

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

/**
 * Debounced command sender. Coalesces rapid characteristic changes (e.g.,
 * HomeKit slider firing 0→25→50→75→100 within the same second) into a
 * single API call with only the final values.
 */
class CommandDebouncer {
  private pending: Record<string, number> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly send: (params: Record<string, number>) => Promise<void>;

  constructor(delayMs: number, send: (params: Record<string, number>) => Promise<void>) {
    this.delayMs = delayMs;
    this.send = send;
  }

  /** Queue parameters to be sent. Values for the same key are overwritten. */
  enqueue(params: Record<string, number>): void {
    Object.assign(this.pending, params);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  private async flush(): Promise<void> {
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

export class PandoHoodAccessory {
  private readonly platform: PandoPlatform;
  private readonly accessory: PlatformAccessory;
  private thingId: string;

  // Services
  private readonly fanService: Service;
  private readonly lightService: Service;
  private readonly filterService: Service;
  private readonly cleanAirService: Service;
  private readonly timerService: Service;
  private readonly infoService: Service;

  // Last-known state (populated by polling)
  private state: Record<string, number> = {};

  // Command debouncer — coalesces rapid set handler calls into one API call.
  private readonly debouncer: CommandDebouncer;

  // Cooldown: after sending a command, skip polling updates until this time.
  private commandCooldownUntil = 0;

  constructor(platform: PandoPlatform, accessory: PlatformAccessory, thing: PgaThing) {
    this.platform = platform;
    this.accessory = accessory;
    this.thingId = thing.uid;
    this.state = { ...thing.capabilities };

    // Create debouncer — coalesces rapid HomeKit changes into one API call.
    this.debouncer = new CommandDebouncer(DEBOUNCE_MS, async (params) => {
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

    const oldTimerSwitch = accessory.getServiceById(Service.Switch, "timer");
    if (oldTimerSwitch) {
      platform.log.info("[%s] Removing old Switch (timer) — migrated to Valve", thing.uid);
      accessory.removeService(oldTimerSwitch);
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
      .setCharacteristic(Characteristic.Model, getThingDisplayName(thing))
      .setCharacteristic(Characteristic.SerialNumber, thing.uid)
      .setCharacteristic(Characteristic.FirmwareRevision,
        getMetaProp(thing, "property.device.fw.version") ?? "1.0",
      );

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
      .setProps({ validValues: [1] })  // Only "Auto" mode — Clean Air is always automatic
      .updateValue(1)                  // Set initial value to Auto before any cache reads
      .onGet(() => 1)                  // Always return Auto
      .onSet(() => {});                // No-op — can't change mode

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
  }

  // ---- State update (called by platform polling) -------------------------

  updateState(thing: PgaThing): void {
    // Command cooldown: skip pushing values to HomeKit if we recently sent
    // a command. This prevents the polling loop from overwriting the user's
    // intended state with stale cloud data before the device settles.
    if (Date.now() < this.commandCooldownUntil) {
      this.platform.log.debug(
        "[%s] Skipping poll update — command cooldown active (%dms remaining)",
        this.thingId,
        this.commandCooldownUntil - Date.now(),
      );
      // Still update internal state so getters return fresh data on next read.
      this.state = { ...thing.capabilities };
      return;
    }

    this.state = { ...thing.capabilities };

    const Characteristic = this.platform.api.hap.Characteristic;

    // Push updated values to HomeKit so the Home app reflects real-time state.
    this.fanService.updateCharacteristic(
      Characteristic.Active,
      this.getFanActive(),
    );
    this.fanService.updateCharacteristic(
      Characteristic.RotationSpeed,
      this.getFanSpeed(),
    );

    this.lightService.updateCharacteristic(
      Characteristic.On,
      this.getLightOn(),
    );
    this.lightService.updateCharacteristic(
      Characteristic.Brightness,
      this.getLightBrightness(),
    );
    this.lightService.updateCharacteristic(
      Characteristic.ColorTemperature,
      this.getLightColorTemperature(),
    );

    this.filterService.updateCharacteristic(
      Characteristic.FilterChangeIndication,
      this.getFilterChangeIndication(),
    );
    this.filterService.updateCharacteristic(
      Characteristic.FilterLifeLevel,
      this.getFilterLifeLevel(),
    );

    this.cleanAirService.updateCharacteristic(
      Characteristic.Active,
      this.getCleanAirActive(),
    );
    this.cleanAirService.updateCharacteristic(
      Characteristic.CurrentAirPurifierState,
      this.getCleanAirCurrentState(),
    );

    this.timerService.updateCharacteristic(
      Characteristic.On,
      this.getTimerOn(),
    );
  }

  // ---- Fan handlers ------------------------------------------------------

  private getFanActive(): CharacteristicValue {
    return (this.state["device.onOff"] ?? 0) ? 1 : 0;
  }

  private async setFanActive(value: CharacteristicValue): Promise<void> {
    const active = value as number;
    this.platform.log.info("[%s] Set fan active: %d", this.thingId, active);

    // Remember light state before turning on the hood — the hood firmware
    // turns the light on at default brightness whenever device.onOff goes to 1.
    const lightWasOff = !this.state["device.lightOnOff"];

    this.state["device.onOff"] = active;

    // Use debouncer — coalesces with simultaneous setFanSpeed calls.
    this.debouncer.enqueue({ "device.onOff": active });

    // Auto-light suppression: if turning on and light was off, schedule a
    // direct (non-debounced) follow-up command after the debounce window
    // fires, to turn the light back off.
    if (active === 1 && lightWasOff) {
      setTimeout(async () => {
        // Re-check: only suppress if light is still supposed to be off
        if (!this.state["device.lightOnOff"]) {
          this.platform.log.info("[%s] Suppressing auto-light (was off before fan on)", this.thingId);
          this.commandCooldownUntil = Date.now() + COMMAND_COOLDOWN_MS;
          await this.platform.client.sendCommand(this.thingId, {
            "device.lightOnOff": 0,
          });
        }
      }, DEBOUNCE_MS + 200);  // Fire after debounced command has been sent
    }
  }

  private getFanSpeed(): CharacteristicValue {
    return fanSpeedToPercent(this.state["device.fanSpeed"] ?? 0);
  }

  private async setFanSpeed(value: CharacteristicValue): Promise<void> {
    const percent = value as number;
    const speed = percentToFanSpeed(percent);
    this.platform.log.info("[%s] Set fan speed: %d%% -> level %d", this.thingId, percent, speed);

    this.state["device.fanSpeed"] = speed;

    // Remember light state before turning on the hood — the hood firmware
    // turns the light on at default brightness whenever device.onOff goes to 1.
    const needsOnOff = speed > 0 && !this.state["device.onOff"];
    const lightWasOff = !this.state["device.lightOnOff"];

    // If setting speed > 0, also turn on the hood.
    const commands: Record<string, number> = { "device.fanSpeed": speed };
    if (needsOnOff) {
      commands["device.onOff"] = 1;
      this.state["device.onOff"] = 1;
    }

    // Use debouncer — coalesces with simultaneous setFanActive calls.
    this.debouncer.enqueue(commands);

    // Auto-light suppression after debounced command fires.
    if (needsOnOff && lightWasOff) {
      setTimeout(async () => {
        if (!this.state["device.lightOnOff"]) {
          this.platform.log.info("[%s] Suppressing auto-light (was off before fan on)", this.thingId);
          this.commandCooldownUntil = Date.now() + COMMAND_COOLDOWN_MS;
          await this.platform.client.sendCommand(this.thingId, {
            "device.lightOnOff": 0,
          });
        }
      }, DEBOUNCE_MS + 200);
    }
  }

  // ---- Light handlers ----------------------------------------------------

  private getLightOn(): CharacteristicValue {
    return (this.state["device.lightOnOff"] ?? 0) === 1;
  }

  private async setLightOn(value: CharacteristicValue): Promise<void> {
    const on = value ? 1 : 0;
    this.platform.log.info("[%s] Set light on: %d", this.thingId, on);
    this.state["device.lightOnOff"] = on;
    this.debouncer.enqueue({ "device.lightOnOff": on });
  }

  private getLightBrightness(): CharacteristicValue {
    // Clamp to minValue 10 — when light is off the hood reports 0.
    return Math.max(10, this.state["device.lightBrightness"] ?? 100);
  }

  private async setLightBrightness(value: CharacteristicValue): Promise<void> {
    const brightness = Math.max(10, Math.min(100, value as number));
    this.platform.log.info("[%s] Set light brightness: %d%%", this.thingId, brightness);
    this.state["device.lightBrightness"] = brightness;
    this.debouncer.enqueue({ "device.lightBrightness": brightness });
  }

  private getLightColorTemperature(): CharacteristicValue {
    const kelvin = this.state["device.lightColorTemperature"] ?? 2700;
    const clamped = Math.max(2700, Math.min(6000, kelvin));
    // Clamp mireds to characteristic range (167-370).
    return Math.max(kelvinToMireds(6000), Math.min(kelvinToMireds(2700), kelvinToMireds(clamped)));
  }

  private async setLightColorTemperature(value: CharacteristicValue): Promise<void> {
    const mireds = value as number;
    const kelvin = Math.max(2700, Math.min(6000, miredsToKelvin(mireds)));
    this.platform.log.info("[%s] Set light color temperature: %d mireds -> %dK", this.thingId, mireds, kelvin);
    this.state["device.lightColorTemperature"] = kelvin;
    this.debouncer.enqueue({ "device.lightColorTemperature": kelvin });
  }

  // ---- Filter handlers ---------------------------------------------------

  private getFilterChangeIndication(): CharacteristicValue {
    // 0 = filter OK, 1 = filter needs change
    return (this.state["device.filter1.worn"] ?? 0) === 1 ? 1 : 0;
  }

  private getFilterLifeLevel(): CharacteristicValue {
    // filter1Value is remaining time in seconds, max 360000 (100 hours).
    // HomeKit expects 0-100 percentage.
    const remaining = this.state["device.filter1Value"] ?? 0;
    const max = 360000;
    return Math.round((remaining / max) * 100);
  }

  // ---- Clean Air handlers (Air Purifier) ---------------------------------

  private getCleanAirActive(): CharacteristicValue {
    return (this.state["device.cleanAirEnabled"] ?? 0) === 1 ? 1 : 0;
  }

  private getCleanAirCurrentState(): CharacteristicValue {
    // 0 = Inactive, 1 = Idle, 2 = Purifying Air
    const enabled = this.state["device.cleanAirEnabled"] ?? 0;
    return enabled === 1 ? 2 : 0;
  }

  private async setCleanAirActive(value: CharacteristicValue): Promise<void> {
    const active = (value as number) === 1 ? 1 : 0;
    this.platform.log.info("[%s] Set clean air: %d", this.thingId, active);
    this.state["device.cleanAirEnabled"] = active;
    this.debouncer.enqueue({ "device.cleanAirEnabled": active });
  }

  // ---- Timer handlers (Switch) --------------------------------------------

  private getTimerOn(): CharacteristicValue {
    // On if either enabled or actively running.
    const enabled = this.state["device.timer.enable"] ?? 0;
    const active = this.state["device.timer.active"] ?? 0;
    return (enabled === 1 || active === 1);
  }

  private async setTimerActive(value: CharacteristicValue): Promise<void> {
    const on = value ? 1 : 0;
    this.platform.log.info("[%s] Set timer: %s", this.thingId, on ? "ON" : "OFF");

    if (on) {
      // When enabling, also send the duration to ensure the hood has a value.
      const duration = this.state["device.timerValue"] ?? DEFAULT_TIMER_DURATION;
      this.state["device.timer.enable"] = 1;
      this.state["device.timerValue"] = duration;
      this.debouncer.enqueue({
        "device.timer.enable": 1,
        "device.timerValue": duration,
      });
    } else {
      this.state["device.timer.enable"] = 0;
      this.debouncer.enqueue({ "device.timer.enable": 0 });
    }
  }
}
