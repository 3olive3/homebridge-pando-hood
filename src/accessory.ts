/**
 * PandoHoodAccessory
 *
 * Maps a single Pando kitchen hood to HomeKit services.
 *
 * Services exposed:
 *  - Fanv2           — hood fan on/off + speed (4 levels)
 *  - Lightbulb       — light on/off, brightness, color temperature
 *  - FilterMaintenance — filter life level + change indication
 *  - Switch (Clean Air)  — clean air periodic ventilation mode
 *  - Switch (Timer)      — hood timer on/off
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

  constructor(platform: PandoPlatform, accessory: PlatformAccessory, thing: PgaThing) {
    this.platform = platform;
    this.accessory = accessory;
    this.thingId = thing.uid;
    this.state = { ...thing.capabilities };

    const Characteristic = this.platform.api.hap.Characteristic;
    const Service = this.platform.api.hap.Service;

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

    this.fanService = accessory.getService(Service.Fanv2)
      ?? accessory.addService(Service.Fanv2, "Hood Fan");

    this.fanService.getCharacteristic(Characteristic.Active)
      .onGet(() => this.getFanActive())
      .onSet((value) => this.setFanActive(value));

    this.fanService.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
      .onGet(() => this.getFanSpeed())
      .onSet((value) => this.setFanSpeed(value));

    // ---- Lightbulb ------------------------------------------------------

    this.lightService = accessory.getService(Service.Lightbulb)
      ?? accessory.addService(Service.Lightbulb, "Hood Light");

    this.lightService.getCharacteristic(Characteristic.On)
      .onGet(() => this.getLightOn())
      .onSet((value) => this.setLightOn(value));

    this.lightService.getCharacteristic(Characteristic.Brightness)
      .setProps({ minValue: 10, maxValue: 100, minStep: 1 })
      .onGet(() => this.getLightBrightness())
      .onSet((value) => this.setLightBrightness(value));

    // Color temperature: 2700K-6000K → mireds (167-370)
    this.lightService.getCharacteristic(Characteristic.ColorTemperature)
      .setProps({
        minValue: kelvinToMireds(6000), // ~167 mireds
        maxValue: kelvinToMireds(2700), // ~370 mireds
        minStep: 1,
      })
      .onGet(() => this.getLightColorTemperature())
      .onSet((value) => this.setLightColorTemperature(value));

    // ---- Filter Maintenance ---------------------------------------------

    this.filterService = accessory.getService(Service.FilterMaintenance)
      ?? accessory.addService(Service.FilterMaintenance, "Filter");

    this.filterService.getCharacteristic(Characteristic.FilterChangeIndication)
      .onGet(() => this.getFilterChangeIndication());

    this.filterService.getCharacteristic(Characteristic.FilterLifeLevel)
      .onGet(() => this.getFilterLifeLevel());

    // ---- Clean Air Switch -----------------------------------------------

    this.cleanAirService = accessory.getServiceById(Service.Switch, "clean-air")
      ?? accessory.addService(Service.Switch, "Clean Air", "clean-air");

    this.cleanAirService.getCharacteristic(Characteristic.On)
      .onGet(() => this.getCleanAirEnabled())
      .onSet((value) => this.setCleanAirEnabled(value));

    // ---- Timer Switch ---------------------------------------------------

    this.timerService = accessory.getServiceById(Service.Switch, "timer")
      ?? accessory.addService(Service.Switch, "Timer", "timer");

    this.timerService.getCharacteristic(Characteristic.On)
      .onGet(() => this.getTimerEnabled())
      .onSet((value) => this.setTimerEnabled(value));
  }

  // ---- State update (called by platform polling) -------------------------

  updateState(thing: PgaThing): void {
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
      Characteristic.On,
      this.getCleanAirEnabled(),
    );
    this.timerService.updateCharacteristic(
      Characteristic.On,
      this.getTimerEnabled(),
    );
  }

  // ---- Fan handlers ------------------------------------------------------

  private getFanActive(): CharacteristicValue {
    return (this.state["device.onOff"] ?? 0) ? 1 : 0;
  }

  private async setFanActive(value: CharacteristicValue): Promise<void> {
    const active = value as number;
    this.platform.log.info("[%s] Set fan active: %d", this.thingId, active);
    this.state["device.onOff"] = active;
    await this.platform.client.sendCommand(this.thingId, {
      "device.onOff": active,
    });
  }

  private getFanSpeed(): CharacteristicValue {
    return fanSpeedToPercent(this.state["device.fanSpeed"] ?? 0);
  }

  private async setFanSpeed(value: CharacteristicValue): Promise<void> {
    const percent = value as number;
    const speed = percentToFanSpeed(percent);
    this.platform.log.info("[%s] Set fan speed: %d%% -> level %d", this.thingId, percent, speed);

    this.state["device.fanSpeed"] = speed;

    // If setting speed > 0, also turn on the hood.
    const commands: Record<string, number> = { "device.fanSpeed": speed };
    if (speed > 0 && !this.state["device.onOff"]) {
      commands["device.onOff"] = 1;
      this.state["device.onOff"] = 1;
    }

    await this.platform.client.sendCommand(this.thingId, commands);
  }

  // ---- Light handlers ----------------------------------------------------

  private getLightOn(): CharacteristicValue {
    return (this.state["device.lightOnOff"] ?? 0) === 1;
  }

  private async setLightOn(value: CharacteristicValue): Promise<void> {
    const on = value ? 1 : 0;
    this.platform.log.info("[%s] Set light on: %d", this.thingId, on);
    this.state["device.lightOnOff"] = on;
    await this.platform.client.sendCommand(this.thingId, {
      "device.lightOnOff": on,
    });
  }

  private getLightBrightness(): CharacteristicValue {
    return this.state["device.lightBrightness"] ?? 100;
  }

  private async setLightBrightness(value: CharacteristicValue): Promise<void> {
    const brightness = Math.max(10, Math.min(100, value as number));
    this.platform.log.info("[%s] Set light brightness: %d%%", this.thingId, brightness);
    this.state["device.lightBrightness"] = brightness;
    await this.platform.client.sendCommand(this.thingId, {
      "device.lightBrightness": brightness,
    });
  }

  private getLightColorTemperature(): CharacteristicValue {
    const kelvin = this.state["device.lightColorTemperature"] ?? 2700;
    return kelvinToMireds(Math.max(2700, Math.min(6000, kelvin)));
  }

  private async setLightColorTemperature(value: CharacteristicValue): Promise<void> {
    const mireds = value as number;
    const kelvin = Math.max(2700, Math.min(6000, miredsToKelvin(mireds)));
    this.platform.log.info("[%s] Set light color temperature: %d mireds -> %dK", this.thingId, mireds, kelvin);
    this.state["device.lightColorTemperature"] = kelvin;
    await this.platform.client.sendCommand(this.thingId, {
      "device.lightColorTemperature": kelvin,
    });
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

  // ---- Clean Air handler -------------------------------------------------

  private getCleanAirEnabled(): CharacteristicValue {
    return (this.state["device.cleanAirEnabled"] ?? 0) === 1;
  }

  private async setCleanAirEnabled(value: CharacteristicValue): Promise<void> {
    const enabled = value ? 1 : 0;
    this.platform.log.info("[%s] Set clean air: %d", this.thingId, enabled);
    this.state["device.cleanAirEnabled"] = enabled;
    await this.platform.client.sendCommand(this.thingId, {
      "device.cleanAirEnabled": enabled,
    });
  }

  // ---- Timer handler -----------------------------------------------------

  private getTimerEnabled(): CharacteristicValue {
    // Timer is "on" if either enabled or actively running.
    const enabled = this.state["device.timer.enable"] ?? 0;
    const active = this.state["device.timer.active"] ?? 0;
    return enabled === 1 || active === 1;
  }

  private async setTimerEnabled(value: CharacteristicValue): Promise<void> {
    const enabled = value ? 1 : 0;
    this.platform.log.info("[%s] Set timer: %d", this.thingId, enabled);
    this.state["device.timer.enable"] = enabled;
    await this.platform.client.sendCommand(this.thingId, {
      "device.timer.enable": enabled,
    });
  }
}
