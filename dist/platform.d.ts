/**
 * PandoPlatform
 *
 * Homebridge dynamic platform plugin. Discovers all Pando hoods associated
 * with the authenticated PGA IoT account and creates accessories for each.
 */
import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from "homebridge";
import { PgaApiClient } from "./api-client";
export declare class PandoPlatform implements DynamicPlatformPlugin {
    readonly api: API;
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly client: PgaApiClient;
    /** Cached accessories restored from disk by Homebridge. */
    private readonly cachedAccessories;
    /** Active accessory handlers (keyed by thing UID). */
    private readonly activeAccessories;
    /** Polling interval handle. */
    private pollTimer?;
    constructor(log: Logger, config: PlatformConfig, api: API);
    /**
     * Called by Homebridge for each accessory restored from cache.
     * We store them and decide later (in discoverDevices) whether to keep or remove them.
     */
    configureAccessory(accessory: PlatformAccessory): void;
    private discoverDevices;
    private startPolling;
}
