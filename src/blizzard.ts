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
// Blizzard limits clients to 100 requests/second (and 36,000/hour). We cap at half that so
// parallel work (catalog build, guild sync, armory dialog) has headroom for latency jitter.
const MAX_PER_SECOND = 50;
const WINDOW_MS = 1000;
// Retries (shared budget) for 429s, transient 5xx and fetch rejections (network blip, timeout)
// before giving up; each waits 1 s x attempt unless Retry-After says otherwise.
const MAX_RETRIES = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Creds = Pick<BlizzardConfig, "clientId" | "clientSecret" | "region" | "namespace">;

// Result of a conditional GET: unchanged since the given time, or the current body (null on 404)
// with its Last-Modified for the next check.
export type Conditional<T> = { modified: false } | { modified: true; body: T | null; lastModified: string | null };

// Error code or name for diagnosis only; never the message, URL or headers.
function causeLabel(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const label = cause?.code ?? (err as { code?: unknown } | null)?.code ?? (err as { name?: unknown } | null)?.name;
  return typeof label === "string" && /^[\w.-]{1,40}$/.test(label) ? label : "unknown";
}

// Retry-After (seconds) when present and numeric, else 1s x attempt number.
function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  const seconds = header !== null && header.trim() !== "" ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : 1000 * attempt;
}

// Client-credentials Battle.net client for the WoW Profile API. Server-side only.
export class BlizzardClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;
  // Start times of API requests in the last WINDOW_MS (oldest first).
  private recentStarts: number[] = [];

  constructor(
    private creds: Creds,
    private fetchFn: FetchFn = fetch,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  get profileNamespace(): string {
    return this.namespaceFor("profile");
  }

  get staticNamespace(): string {
    return this.namespaceFor("static");
  }

  private namespaceFor(kind: "profile" | "static"): string {
    const { namespace, region } = this.creds;
    return namespace === "retail" ? `${kind}-${region}` : `${kind}-${namespace}-${region}`;
  }

  // GET a Profile API path. Resolves null on 404 (unknown/hidden character or guild).
  profile<T>(path: string): Promise<T | null> {
    return this.get<T>(path, this.profileNamespace);
  }

  // Profile GET with If-Modified-Since. Blizzard answers 304 when the character hasn't
  // changed (all character endpoints share the last-login time as Last-Modified).
  async profileIfModified<T>(path: string, since: string | null): Promise<Conditional<T>> {
    const res = await this.request(path, this.profileNamespace, {}, since ? { "if-modified-since": since } : {});
    if (res.status === 304) return { modified: false };
    return { modified: true, body: await this.parse<T>(res), lastModified: res.headers.get("last-modified") };
  }

  // GET a Game Data API path backed by static data (items, media, search). Resolves null on 404.
  gameData<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
    return this.get<T>(path, this.staticNamespace, params);
  }

  private async get<T>(path: string, namespace: string, params: Record<string, string> = {}): Promise<T | null> {
    return this.parse<T>(await this.request(path, namespace, params));
  }

  private async parse<T>(res: Response): Promise<T | null> {
    if (res.status === 404) return null;
    if (!res.ok) throw new BlizzardError(`blizzard api returned ${res.status}`);
    return (await res.json()) as T;
  }

  private async request(
    path: string,
    namespace: string,
    params: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const query = new URLSearchParams({ ...params, namespace, locale: "en_US" });
    const url = `https://${this.creds.region}.api.blizzard.com${path}?${query}`;
    let res = await this.send(url, await this.accessToken(), headers);
    if (res.status === 401) {
      // Token revoked or expired early: fetch a fresh one and retry once.
      this.token = null;
      res = await this.send(url, await this.accessToken(), headers);
    }
    return res;
  }

  // One API call, retrying 429s with backoff. Each attempt takes a rate-limit slot.
  private async send(url: string, token: string, headers: Record<string, string>): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      // Only yield when we actually have to wait, so a free slot goes straight to fetch.
      if (!this.tryTakeSlot()) await this.waitForSlot();
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { ...headers, authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt > MAX_RETRIES) throw new BlizzardError(`blizzard api unreachable (${causeLabel(err)})`);
        await this.sleep(1000 * attempt);
        continue;
      }
      if (!RETRY_STATUSES.has(res.status) || attempt > MAX_RETRIES) return res;
      await this.sleep(retryDelayMs(res, attempt));
    }
  }

  // Claim a slot if fewer than MAX_PER_SECOND requests started in the last second. Check and
  // claim happen in one synchronous step, so concurrent callers can't all pass the check.
  private tryTakeSlot(): boolean {
    const now = this.now();
    while (this.recentStarts.length > 0 && this.recentStarts[0] <= now - WINDOW_MS) this.recentStarts.shift();
    if (this.recentStarts.length >= MAX_PER_SECOND) return false;
    this.recentStarts.push(now);
    return true;
  }

  // Sleep until the oldest start leaves the window, then claim a slot (woken waiters re-check).
  private async waitForSlot(): Promise<void> {
    while (!this.tryTakeSlot()) {
      await this.sleep(Math.max(1, this.recentStarts[0] + WINDOW_MS - this.now()));
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
