import {
  AccessoryPlugin,
  API,
  HAP,
  Logging,
  PlatformConfig,
  StaticPlatformPlugin,
} from 'homebridge';
import { ShellyPlus1DoorbellAccessory } from './accessory';
import { DoorbellConfig, PlatformPluginConfig } from './config';

const PLATFORM_NAME = 'ShellyPlus1Doorbell';

let hap: HAP;

/**
 * Homebridge plugin entry — registers the Shelly Plus 1 doorbell platform.
 */
export = (api: API) => {
  hap = api.hap;
  api.registerPlatform(PLATFORM_NAME, ShellyPlus1DoorbellPlatform);
};

class ShellyPlus1DoorbellPlatform implements StaticPlatformPlugin {
  private readonly config: PlatformPluginConfig;

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.config = config as PlatformPluginConfig;
    this.log.info('Shelly Plus 1 Doorbell platform initializing');
  }

  accessories(callback: (foundAccessories: AccessoryPlugin[]) => void): void {
    const homebridgeIp = this.config.homebridgeIp;
    const doorbells = this.config.doorbells || [];

    if (!homebridgeIp) {
      this.log.error('homebridgeIp is required — Shelly cannot reach Homebridge without it');
      callback([]);
      return;
    }

    if (doorbells.length === 0) {
      this.log.warn('No doorbells configured');
      callback([]);
      return;
    }

    const ports = new Set<number>();
    const accessories: AccessoryPlugin[] = [];

    for (const doorbell of doorbells) {
      if (!this.validateDoorbell(doorbell, ports)) {
        continue;
      }
      accessories.push(
        new ShellyPlus1DoorbellAccessory(
          this.api,
          hap,
          this.log,
          doorbell,
          homebridgeIp,
        ),
      );
    }

    callback(accessories);
  }

  private validateDoorbell(doorbell: DoorbellConfig, ports: Set<number>): boolean {
    if (!doorbell.shellyIp) {
      this.log.error(`Doorbell "${doorbell.name}" is missing shellyIp`);
      return false;
    }
    if (!doorbell.webhookPort) {
      this.log.error(`Doorbell "${doorbell.name}" is missing webhookPort`);
      return false;
    }
    if (ports.has(doorbell.webhookPort)) {
      this.log.error(
        `Doorbell "${doorbell.name}" webhookPort ${doorbell.webhookPort} is already used by another doorbell`,
      );
      return false;
    }
    ports.add(doorbell.webhookPort);
    return true;
  }
}
