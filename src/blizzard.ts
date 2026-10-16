import type { BlizzardConfig } from "./config.js";

export type FetchFn = typeof fetch;

// Upstream failure (network, timeout, non-2xx other than 404). Never carries the secret or token.
export class BlizzardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlizzardError";
  }
}

const TOKEN_URL = "https://oauth.battle.net/token";
const TIMEOUT_MS = 10_000;
// Refresh a little early so a token never expires mid-request.
const TOKEN_MARGIN_MS = 60_000;

type Creds = Pick<BlizzardConfig, "clientId" | "clientSecret" | "region" | "namespace">;

// Client-credentials Battle.net client for the WoW Profile API. Server-side only.
export class BlizzardClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(
    private creds: Creds,
    private fetchFn: FetchFn = fetch,
    private now: () => number = Date.now,
  ) {}

  get profileNamespace(): string {
    const { namespace, region } = this.creds;
    return namespace === "retail" ? `profile-${region}` : `profile-${namespace}-${region}`;
  }

  // GET a Profile API path. Resolves null on 404 (unknown/hidden character or guild).
  async profile<T>(path: string): Promise<T | null> {
    const url = `https://${this.creds.region}.api.blizzard.com${path}?namespace=${this.profileNamespace}&locale=en_US`;
    let res = await this.send(url, await this.accessToken());
    if (res.status === 401) {
      // Token revoked or expired early: fetch a fresh one and retry once.
      this.token = null;
      res = await this.send(url, await this.accessToken());
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new BlizzardError(`blizzard api returned ${res.status}`);
    return (await res.json()) as T;
  }

  private async send(url: string, token: string): Promise<Response> {
    try {
      return await this.fetchFn(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new BlizzardError("blizzard api unreachable");
    }
  }

  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return Promise.resolve(this.token.value);
    // Share one in-flight token request between concurrent callers.
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchFn(TOKEN_URL, {
        method: "POST",
        headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new BlizzardError("blizzard oauth unreachable");
    }
    if (!res.ok) throw new BlizzardError(`blizzard oauth returned ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new BlizzardError("blizzard oauth returned an unexpected body");
    }
    this.token = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1000 - TOKEN_MARGIN_MS };
    return body.access_token;
  }
}
