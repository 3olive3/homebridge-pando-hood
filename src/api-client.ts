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

const API_BASE = "https://pando.iotpga.it";

/** Token expiry safety margin — refresh 5 minutes before actual expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    sort: { orderBy: unknown[] };
  };
  totalPages: number;
  pageNumber: number;
  numberOfElements: number;
  empty: boolean;
  size: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard: is this metadata entry a property (has .value string)? */
function isPropertyMeta(entry: PgaCapabilityMeta | PgaPropertyMeta | string): entry is PgaPropertyMeta {
  return typeof entry === "object" && entry !== null && "value" in entry;
}

/**
 * Extract a string property from a thing's metadata.
 * Property entries use the format `{ value: "..." }` while capability entries
 * use `{ data_type, min_value, max_value, def_value }`.
 */
export function getMetaProp(thing: PgaThing, key: string): string | undefined {
  const entry = thing.metadata[key];
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && isPropertyMeta(entry)) {
    return entry.value;
  }
  return undefined;
}

/** Get the device display name from metadata, falling back to the thing UID. */
export function getThingDisplayName(thing: PgaThing): string {
  return getMetaProp(thing, "property.device_name") ?? thing.uid;
}

/** Get the device model identifier from metadata (e.g. "pga-hood-0"). */
export function getThingModel(thing: PgaThing): string | undefined {
  const model = thing.metadata["model"];
  if (typeof model === "string") {
    return model;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PgaApiClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
  ) {}

  // ---- Authentication ----------------------------------------------------

  /**
   * Authenticate with the PGA IoT API and cache the JWT.
   * Called automatically by `request()` when the token is missing or expired.
   */
  async login(): Promise<void> {
    this.log.debug("PGA API: Authenticating...");

    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PGA login failed (${res.status}): ${body}`);
    }

    const data: PgaAuthResponse = await res.json() as PgaAuthResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000 - TOKEN_REFRESH_MARGIN_MS;

    this.log.debug("PGA API: Authenticated (token expires in %ds)", data.expires_in);
  }

  /** Ensure we have a valid token, refreshing if necessary. */
  private async ensureToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.login();
    }
    return this.accessToken!;
  }

  // ---- Generic request ---------------------------------------------------

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const token = await this.ensureToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    const init: RequestInit = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetch(`${API_BASE}${path}`, init);

    // Handle 401 — token may have been invalidated server-side.
    if (res.status === 401) {
      this.log.warn("PGA API: Token rejected, re-authenticating...");
      this.accessToken = null;
      const freshToken = await this.ensureToken();
      headers.Authorization = `Bearer ${freshToken}`;
      const retry = await fetch(`${API_BASE}${path}`, { method, headers, body: init.body });
      if (!retry.ok) {
        const text = await retry.text();
        throw new Error(`PGA API ${method} ${path} failed after re-auth (${retry.status}): ${text}`);
      }
      const contentType = retry.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return await retry.json() as T;
      }
      return undefined as T;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PGA API ${method} ${path} failed (${res.status}): ${text}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await res.json() as T;
    }
    return undefined as T;
  }

  // ---- Device endpoints --------------------------------------------------

  /** List all devices (things) associated with the authenticated user. */
  async getThings(): Promise<PgaThing[]> {
    const data = await this.request<PgaThingsResponse>("GET", "/api/things?page=0&size=100");
    return data.content ?? [];
  }

  /** Get a single device by its thing UID (e.g. "PAN-00001234"). */
  async getThing(thingId: string): Promise<PgaThing> {
    return await this.request<PgaThing>("GET", `/api/things/${thingId}`);
  }

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
  async sendCommand(thingId: string, command: Record<string, number>): Promise<void> {
    const parameters = Object.entries(command).map(([id, value]) => ({ id, value }));

    const payload = {
      command: "setValue",
      requestId: crypto.randomUUID(),
      parameters,
      deviceType: "smartphone",
    };

    // Note: this endpoint lives at /devices/{uid}/set_value (no /api prefix).
    await this.request<void>("POST", `/devices/${thingId}/set_value`, payload as unknown as Record<string, unknown>);
  }
}
