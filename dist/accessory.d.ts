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
import { PlatformAccessory } from "homebridge";
import { PandoPlatform } from "./platform";
import { PgaThing } from "./api-client";
export declare class PandoHoodAccessory {
    private readonly platform;
    private readonly accessory;
    private thingId;
    private readonly fanService;
    private readonly lightService;
    private readonly filterService;
    private readonly cleanAirService;
    private readonly timerService;
    private readonly infoService;
    private state;
    private lastFanSpeed;
    private readonly debouncer;
    private commandCooldownUntil;
    constructor(platform: PandoPlatform, accessory: PlatformAccessory, thing: PgaThing);
    updateState(thing: PgaThing): void;
    /** Push current internal state to HomeKit characteristics. */
    private pushStateToHomeKit;
    private getFanActive;
    private setFanActive;
    private getFanSpeed;
    private setFanSpeed;
    private getLightOn;
    private setLightOn;
    private getLightBrightness;
    private setLightBrightness;
    private getLightColorTemperature;
    private setLightColorTemperature;
    private getFilterChangeIndication;
    private getFilterLifeLevel;
    private getCleanAirActive;
    private getCleanAirCurrentState;
    private setCleanAirActive;
    private getTimerOn;
    private setTimerActive;
}
