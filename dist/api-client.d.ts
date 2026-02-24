/**
 * PGA IoT API Client
 *
 * Handles authentication and communication with the PGA IoT cloud platform
 * (iotpga.it) used by Pando kitchen hoods.
 *
 * API base: https://pando.iotpga.it
 * Auth: POST /api/auth/login -> Bearer JWT (4-hour expiry)
 * Devices: GET /api/things
 * State: GET /api/things/{thingId}
 * Control: POST /devices/{uid}/set_value
 */
import { Logger } from "homebridge";
export interface PgaAuthResponse {
    username: string;
    roles: string[];
    access_token: string;
    token_type: string;
    /** Token lifetime in seconds (typically 14400 = 4 hours). */
    expires_in: number;
}
export interface PgaCapabilityMeta {
    data_type: number;
    min_value: number;
    max_value: number;
    def_value: number;
}
export interface PgaPropertyMeta {
    value: string;
}
export interface PgaThing {
    uid: string;
    description: string;
    enabled: boolean;
    online: boolean;
    lastMessage: string;
    created: string;
    updated: string;
    childrenUid: string[];
    metadata: Record<string, PgaCapabilityMeta | PgaPropertyMeta | string>;
    capabilities: Record<string, number>;
    alarmEvents: unknown[];
}
export interface PgaThingsResponse {
    totalSize: number;
    content: PgaThing[];
    pageable: {
        number: number;
        size: number;
        sort: {
            orderBy: unknown[];
        };
    };
    totalPages: number;
    pageNumber: number;
    numberOfElements: number;
    empty: boolean;
    size: number;
    offset: number;
}
/**
 * Extract a string property from a thing's metadata.
 * Property entries use the format `{ value: "..." }` while capability entries
 * use `{ data_type, min_value, max_value, def_value }`.
 */
export declare function getMetaProp(thing: PgaThing, key: string): string | undefined;
/** Get the device display name from metadata, falling back to the thing UID. */
export declare function getThingDisplayName(thing: PgaThing): string;
/** Get the device model identifier from metadata (e.g. "pga-hood-0"). */
export declare function getThingModel(thing: PgaThing): string | undefined;
export declare class PgaApiClient {
    private readonly username;
    private readonly password;
    private readonly log;
    private accessToken;
    private tokenExpiresAt;
    constructor(username: string, password: string, log: Logger);
    /**
     * Authenticate with the PGA IoT API and cache the JWT.
     * Called automatically by `request()` when the token is missing or expired.
     */
    login(): Promise<void>;
    /** Ensure we have a valid token, refreshing if necessary. */
    private ensureToken;
    private request;
    /** List all devices (things) associated with the authenticated user. */
    getThings(): Promise<PgaThing[]>;
    /** Get a single device by its thing UID (e.g. "PAN-00001234"). */
    getThing(thingId: string): Promise<PgaThing>;
    /**
     * Send a command to a device via the confirmed REST endpoint.
     *
     * Callers pass a flat capability map (e.g. `{ "device.lightOnOff": 1 }`).
     * Each key-value pair is sent as a separate parameter in the `DeviceCommand`
     * payload expected by the PGA IoT backend.
     *
     * Endpoint: POST /devices/{uid}/set_value  (NOT /api/devices/...)
     * Payload:  { command: "setValue", requestId: uuid, parameters: [{id, value}], deviceType: "smartphone" }
     * Response: 200 with empty body on success.
     *
     * @param thingId  Device UID (e.g. "PAN-00001234")
     * @param command  Capability key-value pairs (e.g. `{ "device.lightOnOff": 1 }`)
     */
    sendCommand(thingId: string, command: Record<string, number>): Promise<void>;
}
