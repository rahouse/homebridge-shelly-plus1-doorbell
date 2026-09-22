import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { createHash, randomInt } from 'crypto';
import { Logging } from 'homebridge';

export interface SwitchConfig {
  id: number;
  name: string | null;
  in_mode: string;
  initial_state: string;
  auto_on: boolean;
  auto_on_delay?: number;
  auto_off: boolean;
  auto_off_delay: number;
}

export interface WebhookHook {
  id: number;
  cid: number;
  enable: boolean;
  event: string;
  name: string | null;
  urls: string[];
  condition?: string | null;
  repeat_period?: number;
}

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  algorithm?: string;
  opaque?: string;
}

const WEBHOOK_NAME = 'Homebridge Doorbell';
const BUTTON_EVENT = 'input.button_push';

/**
 * Thin Gen2 RPC client for Shelly Plus 1 with SHA-256 digest auth.
 */
export class ShellyPlus1Client {
  private readonly http: AxiosInstance;
  private readonly username: string;
  private readonly password: string | undefined;
  private rpcId = 1;

  constructor(
    private readonly shellyIp: string,
    private readonly log: Logging,
    username?: string,
    password?: string,
  ) {
    this.username = username || 'admin';
    this.password = password;
    this.http = axios.create({
      baseURL: `http://${shellyIp}`,
      timeout: 10_000,
      validateStatus: (status) => status < 500,
    });
  }

  async configureInputAsButton(): Promise<void> {
    await this.rpc('Input.SetConfig', {
      id: 0,
      config: { type: 'button' },
    });
  }

  async getSwitchConfig(): Promise<SwitchConfig> {
    return this.rpc<SwitchConfig>('Switch.GetConfig', { id: 0 });
  }

  async isMechanicalGongActive(): Promise<boolean> {
    const config = await this.getSwitchConfig();
    return config.in_mode !== 'detached';
  }

  async setMechanicalGongActive(active: boolean, autoOffDelay = 0.2): Promise<void> {
    await this.rpc('Switch.SetConfig', {
      id: 0,
      config: {
        in_mode: active ? 'momentary' : 'detached',
        initial_state: 'off',
        auto_on: false,
        auto_off: true,
        auto_off_delay: autoOffDelay,
      },
    });
  }

  async ensureDoorbellWebhook(homebridgeIp: string, webhookPort: number): Promise<void> {
    const url = `http://${homebridgeIp}:${webhookPort}/`;
    const listed = await this.rpc<{ hooks: WebhookHook[] }>('Webhook.List');
    const existing = listed.hooks?.find((hook) => hook.name === WEBHOOK_NAME);

    if (existing) {
      await this.rpc('Webhook.Update', {
        id: existing.id,
        enable: true,
        event: BUTTON_EVENT,
        cid: 0,
        urls: [url],
        name: WEBHOOK_NAME,
        repeat_period: 0,
      });
      this.log.info(`Updated Shelly webhook "${WEBHOOK_NAME}" → ${url}`);
      return;
    }

    await this.rpc('Webhook.Create', {
      enable: true,
      event: BUTTON_EVENT,
      cid: 0,
      urls: [url],
      name: WEBHOOK_NAME,
      repeat_period: 0,
    });
    this.log.info(`Created Shelly webhook "${WEBHOOK_NAME}" → ${url}`);
  }

  async setupDoorbell(
    homebridgeIp: string,
    webhookPort: number,
    mechanicalActive: boolean,
    autoOffDelay: number,
  ): Promise<void> {
    await this.configureInputAsButton();
    await this.ensureDoorbellWebhook(homebridgeIp, webhookPort);
    await this.setMechanicalGongActive(mechanicalActive, autoOffDelay);
  }

  private async rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const body: Record<string, unknown> = {
      id: this.rpcId++,
      method,
      src: 'homebridge-shelly-plus1-doorbell',
    };
    if (params !== undefined) {
      body.params = params;
    }

    const response = await this.requestWithDigest({
      method: 'POST',
      url: '/rpc',
      data: body,
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.status === 401) {
      throw new Error(
        `Shelly at ${this.shellyIp} requires authentication. Set shellyPassword in the plugin config.`,
      );
    }

    if (response.status >= 400) {
      throw new Error(`Shelly RPC HTTP ${response.status} for ${method}: ${JSON.stringify(response.data)}`);
    }

    const data = response.data as {
      result?: T;
      error?: { code: number; message: string };
    };

    if (data.error) {
      throw new Error(`Shelly RPC ${method} failed (${data.error.code}): ${data.error.message}`);
    }

    return data.result as T;
  }

  private async requestWithDigest(config: AxiosRequestConfig) {
    const first = await this.http.request(config);

    if (first.status !== 401 || !this.password) {
      return first;
    }

    const wwwAuth = first.headers['www-authenticate'];
    if (!wwwAuth || typeof wwwAuth !== 'string') {
      // Gen2 often returns auth challenge in JSON body for /rpc
      const challengeFromBody = this.challengeFromRpcBody(first.data);
      if (!challengeFromBody) {
        return first;
      }
      return this.retryWithAuth(config, challengeFromBody, 'POST', '/rpc');
    }

    const challenge = this.parseWwwAuthenticate(wwwAuth);
    return this.retryWithAuth(config, challenge, 'POST', '/rpc');
  }

  private async retryWithAuth(
    config: AxiosRequestConfig,
    challenge: DigestChallenge,
    httpMethod: string,
    uri: string,
  ) {
    const authHeader = this.buildAuthorizationHeader(challenge, httpMethod, uri);
    const authObject = this.buildAuthObject(challenge, httpMethod, uri);

    try {
      // Prefer Authorization header (standard HTTP digest)
      const withHeader = await this.http.request({
        ...config,
        headers: {
          ...(config.headers || {}),
          Authorization: authHeader,
        },
        data: config.data,
      });

      if (withHeader.status !== 401) {
        return withHeader;
      }
    } catch (error) {
      this.log.debug(`Digest Authorization header attempt failed: ${String(error)}`);
    }

    // Fallback: auth object inside RPC JSON body (Shelly Gen2 style)
    const data = typeof config.data === 'object' && config.data !== null
      ? { ...(config.data as Record<string, unknown>), auth: authObject }
      : config.data;

    return this.http.request({
      ...config,
      data,
    });
  }

  private challengeFromRpcBody(data: unknown): DigestChallenge | undefined {
    if (!data || typeof data !== 'object') {
      return undefined;
    }

    const error = (data as { error?: { code?: number; message?: string } }).error;
    if (!error || error.code !== 401 || !error.message) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(error.message) as {
        realm?: string;
        nonce?: string | number;
        algorithm?: string;
        qop?: string;
      };
      if (!parsed.realm || parsed.nonce === undefined) {
        return undefined;
      }
      return {
        realm: parsed.realm,
        nonce: String(parsed.nonce),
        algorithm: parsed.algorithm || 'SHA-256',
        qop: parsed.qop || 'auth',
      };
    } catch {
      return undefined;
    }
  }

  private parseWwwAuthenticate(header: string): DigestChallenge {
    const get = (key: string): string | undefined => {
      const match = header.match(new RegExp(`${key}="([^"]+)"`, 'i'))
        || header.match(new RegExp(`${key}=([^,\\s]+)`, 'i'));
      return match?.[1];
    };

    const realm = get('realm');
    const nonce = get('nonce');
    if (!realm || !nonce) {
      throw new Error(`Unable to parse WWW-Authenticate from Shelly: ${header}`);
    }

    return {
      realm,
      nonce,
      qop: get('qop') || 'auth',
      algorithm: get('algorithm') || 'SHA-256',
      opaque: get('opaque'),
    };
  }

  private buildAuthObject(challenge: DigestChallenge, httpMethod: string, uri: string) {
    const nc = '00000001';
    const cnonce = randomInt(0, 2_147_483_647);
    const response = this.digestResponse(challenge, httpMethod, uri, nc, String(cnonce));

    return {
      realm: challenge.realm,
      username: this.username,
      nonce: challenge.nonce,
      cnonce,
      nc,
      response,
      algorithm: 'SHA-256',
    };
  }

  private buildAuthorizationHeader(
    challenge: DigestChallenge,
    httpMethod: string,
    uri: string,
  ): string {
    const nc = '00000001';
    const cnonce = String(randomInt(0, 2_147_483_647));
    const response = this.digestResponse(challenge, httpMethod, uri, nc, cnonce);

    const parts = [
      `Digest username="${this.username}"`,
      `realm="${challenge.realm}"`,
      `nonce="${challenge.nonce}"`,
      `uri="${uri}"`,
      `algorithm=SHA-256`,
      `response="${response}"`,
      `qop=${challenge.qop || 'auth'}`,
      `nc=${nc}`,
      `cnonce="${cnonce}"`,
    ];
    if (challenge.opaque) {
      parts.push(`opaque="${challenge.opaque}"`);
    }
    return parts.join(', ');
  }

  private digestResponse(
    challenge: DigestChallenge,
    httpMethod: string,
    uri: string,
    nc: string,
    cnonce: string,
  ): string {
    if (!this.password) {
      throw new Error('Password required for digest auth');
    }

    const ha1 = this.sha256(`${this.username}:${challenge.realm}:${this.password}`);
    const ha2 = this.sha256(`${httpMethod}:${uri}`);
    return this.sha256(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
