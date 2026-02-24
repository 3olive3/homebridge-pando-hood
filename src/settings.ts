/**
 * homebridge-pando-hood
 *
 * Homebridge plugin for Pando kitchen hoods (PGA IoT platform).
 * Exposes fan, light, filter maintenance, and clean air mode to Apple HomeKit.
 */

export const PLUGIN_NAME = "homebridge-pando-hood";
export const PLATFORM_NAME = "PandoHood";

export { PandoPlatform } from "./platform";
