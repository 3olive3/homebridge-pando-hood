"use strict";
/**
 * PandoPlatform
 *
 * Homebridge dynamic platform plugin. Discovers all Pando hoods associated
 * with the authenticated PGA IoT account and creates accessories for each.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PandoPlatform = void 0;
const settings_1 = require("./settings");
const api_client_1 = require("./api-client");
const accessory_1 = require("./accessory");
class PandoPlatform {
    api;
    log;
    config;
    client;
    /** Cached accessories restored from disk by Homebridge. */
    cachedAccessories = new Map();
    /** Active accessory handlers (keyed by thing UID). */
    activeAccessories = new Map();
    /** Polling interval handle. */
    pollTimer;
    /** Consecutive polling failures — used for offline detection. */
    consecutiveFailures = 0;
    /** Number of consecutive poll failures before marking devices offline. */
    static OFFLINE_THRESHOLD = 3;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        const username = config.username;
        const password = config.password;
        if (!username || !password) {
            this.log.error("Pando account credentials (username/password) are required. Plugin will not start.");
            // Still need to register for the didFinishLaunching event for Homebridge to be happy
            this.client = undefined;
            return;
        }
        this.client = new api_client_1.PgaApiClient(username, password, log);
        // Homebridge calls configureAccessory() for each cached accessory before this event fires.
        this.api.on("didFinishLaunching" /* APIEvent.DID_FINISH_LAUNCHING */, () => {
            this.discoverDevices();
        });
    }
    // ---- Cached accessory restore ------------------------------------------
    /**
     * Called by Homebridge for each accessory restored from cache.
     * We store them and decide later (in discoverDevices) whether to keep or remove them.
     */
    configureAccessory(accessory) {
        this.log.debug("Restoring cached accessory: %s", accessory.displayName);
        this.cachedAccessories.set(accessory.UUID, accessory);
    }
    // ---- Discovery ---------------------------------------------------------
    async discoverDevices() {
        if (!this.client) {
            return;
        }
        this.log.info("Discovering Pando devices...");
        let things;
        try {
            things = await this.client.getThings();
        }
        catch (err) {
            this.log.error("Failed to discover devices: %s", err);
            return;
        }
        // Filter to hood-type devices only.
        const hoods = things.filter((t) => {
            const model = (0, api_client_1.getThingModel)(t) ?? "";
            const deviceType = (0, api_client_1.getMetaProp)(t, "property.device.type") ?? "";
            // Accept any thing that looks like a hood — by model, device type, or capabilities.
            return (model.toLowerCase().includes("hood") ||
                deviceType.toLowerCase().includes("hood") ||
                t.capabilities["device.fanSpeed"] !== undefined ||
                t.capabilities["device.onOff"] !== undefined);
        });
        if (hoods.length === 0) {
            // No filter — if all things have hood capabilities, just use all of them.
            // The PGA platform is hood-specific, so all things should be hoods.
            this.log.info("No hood-specific filter matched; using all %d device(s).", things.length);
            hoods.push(...things);
        }
        this.log.info("Found %d Pando hood(s).", hoods.length);
        const discoveredUUIDs = new Set();
        for (const thing of hoods) {
            const uuid = this.api.hap.uuid.generate(thing.uid);
            discoveredUUIDs.add(uuid);
            const displayName = (0, api_client_1.getThingDisplayName)(thing);
            let accessory = this.cachedAccessories.get(uuid);
            let isNew = false;
            if (accessory) {
                // Existing accessory — update context.
                this.log.info("Restoring existing accessory: %s (%s)", displayName, thing.uid);
                accessory.context.thing = thing;
            }
            else {
                // New accessory — create but do NOT register yet.
                // Services must be added first so the cache includes them.
                this.log.info("Adding new accessory: %s (%s)", displayName, thing.uid);
                accessory = new this.api.platformAccessory(displayName, uuid);
                accessory.context.thing = thing;
                isNew = true;
            }
            // Create the handler — this adds all services (Fanv2, Lightbulb,
            // FilterMaintenance, 2x Switch) to the accessory.
            const handler = new accessory_1.PandoHoodAccessory(this, accessory, thing);
            this.activeAccessories.set(thing.uid, handler);
            // Now register/update AFTER services exist so Homebridge serializes
            // the full accessory (with all services) to the cache.
            if (isNew) {
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            }
            else {
                this.api.updatePlatformAccessories([accessory]);
            }
        }
        // Remove stale accessories that are no longer in the account.
        for (const [uuid, accessory] of this.cachedAccessories) {
            if (!discoveredUUIDs.has(uuid)) {
                this.log.info("Removing stale accessory: %s", accessory.displayName);
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            }
        }
        // Start polling for state updates.
        this.startPolling();
    }
    // ---- Polling -----------------------------------------------------------
    startPolling() {
        const intervalSec = this.config.pollingInterval ?? 30;
        const intervalMs = Math.max(intervalSec, 10) * 1000;
        this.log.info("Polling for state updates every %ds.", intervalMs / 1000);
        this.pollTimer = setInterval(async () => {
            try {
                // Fetch all devices in one API call instead of per-device requests.
                const things = await this.client.getThings();
                const thingMap = new Map(things.map((t) => [t.uid, t]));
                // Poll succeeded — clear failure counter.
                const wasOffline = this.consecutiveFailures >= PandoPlatform.OFFLINE_THRESHOLD;
                this.consecutiveFailures = 0;
                for (const [thingId, handler] of this.activeAccessories) {
                    const thing = thingMap.get(thingId);
                    if (thing) {
                        // If recovering from offline, restore online status first.
                        if (wasOffline) {
                            this.log.info("Device %s is back online after %d+ failed polls.", thingId, PandoPlatform.OFFLINE_THRESHOLD);
                            handler.setOnline(true);
                        }
                        handler.updateState(thing);
                    }
                    else {
                        this.log.warn("Device %s not found in API response.", thingId);
                    }
                }
            }
            catch (err) {
                this.consecutiveFailures++;
                this.log.warn("Failed to poll devices (attempt %d/%d): %s", this.consecutiveFailures, PandoPlatform.OFFLINE_THRESHOLD, err);
                // After threshold consecutive failures, mark all accessories as offline.
                if (this.consecutiveFailures === PandoPlatform.OFFLINE_THRESHOLD) {
                    this.log.error("Cloud API unreachable after %d consecutive failures — marking all devices as offline.", PandoPlatform.OFFLINE_THRESHOLD);
                    for (const [, handler] of this.activeAccessories) {
                        handler.setOnline(false);
                    }
                }
            }
        }, intervalMs);
        // Cleanup on shutdown.
        this.api.on("shutdown" /* APIEvent.SHUTDOWN */, () => {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
            }
        });
    }
}
exports.PandoPlatform = PandoPlatform;
//# sourceMappingURL=platform.js.map