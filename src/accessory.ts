import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import {
  API,
  AccessoryPlugin,
  CharacteristicValue,
  HAP,
  Logging,
  Service,
} from 'homebridge';
import { DoorbellConfig } from './config';
import { ShellyPlus1Client } from './shelly';

export class ShellyPlus1DoorbellAccessory implements AccessoryPlugin {
  readonly name: string;

  private readonly shelly: ShellyPlus1Client;
  private readonly webhookPort: number;
  private readonly autoOffDelay: number;
  private readonly homebridgeIp: string;

  private digitalGongEnabled = true;
  private mechanicalGongEnabled = true;

  private readonly informationService: Service;
  private readonly doorbellService: Service;
  private readonly digitalGongService: Service;
  private readonly mechanicalGongService: Service;

  private webhookServer: Server | undefined;

  constructor(
    private readonly api: API,
    private readonly hap: HAP,
    private readonly log: Logging,
    config: DoorbellConfig,
    homebridgeIp: string,
  ) {
    this.name = config.name || 'Doorbell';
    this.homebridgeIp = homebridgeIp;
    this.webhookPort = config.webhookPort;
    this.autoOffDelay = config.autoOffDelay ?? 0.2;

    this.shelly = new ShellyPlus1Client(
      config.shellyIp,
      log,
      config.shellyUsername,
      config.shellyPassword,
    );

    const digitalName = config.digitalDoorbellName || 'Digital gong';
    const mechanicalName = config.mechanicalDoorbellName || 'Mechanical gong';

    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Shelly')
      .setCharacteristic(hap.Characteristic.Model, 'Plus 1 Doorbell')
      .setCharacteristic(hap.Characteristic.SerialNumber, config.shellyIp)
      .setCharacteristic(hap.Characteristic.FirmwareRevision, '1.0.0');

    this.doorbellService = new hap.Service.Doorbell(this.name);

    this.digitalGongService = new hap.Service.Switch(digitalName, 'digitalGong');
    this.digitalGongService.getCharacteristic(hap.Characteristic.On)
      .onGet(() => this.digitalGongEnabled)
      .onSet((value: CharacteristicValue) => {
        this.digitalGongEnabled = Boolean(value);
        this.log.info(`Digital gong ${this.digitalGongEnabled ? 'enabled' : 'disabled'}`);
      });

    this.mechanicalGongService = new hap.Service.Switch(mechanicalName, 'mechanicalGong');
    this.mechanicalGongService.getCharacteristic(hap.Characteristic.On)
      .onGet(async () => {
        try {
          this.mechanicalGongEnabled = await this.shelly.isMechanicalGongActive();
          return this.mechanicalGongEnabled;
        } catch (error) {
          this.log.error(`Failed to read mechanical gong state: ${String(error)}`);
          return this.mechanicalGongEnabled;
        }
      })
      .onSet(async (value: CharacteristicValue) => {
        const active = Boolean(value);
        try {
          await this.shelly.setMechanicalGongActive(active, this.autoOffDelay);
          this.mechanicalGongEnabled = active;
          this.log.info(`Mechanical gong ${active ? 'enabled' : 'disabled'} (detached=${!active})`);
        } catch (error) {
          this.log.error(`Failed to set mechanical gong: ${String(error)}`);
          throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    this.startWebhookServer();
    void this.initializeShelly();

    this.log.info(`Doorbell "${this.name}" created (webhook port ${this.webhookPort})`);
  }

  identify(): void {
    this.log.info(`Identify ${this.name}`);
  }

  getServices(): Service[] {
    return [
      this.informationService,
      this.doorbellService,
      this.digitalGongService,
      this.mechanicalGongService,
    ];
  }

  private startWebhookServer(): void {
    this.webhookServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      this.handleWebhook(request, response);
    });

    this.webhookServer.on('error', (error: NodeJS.ErrnoException) => {
      this.log.error(`Webhook server error on port ${this.webhookPort}: ${error.message}`);
    });

    this.webhookServer.listen(this.webhookPort, () => {
      this.log.info(
        `Digital doorbell webhook listening on http://${this.homebridgeIp}:${this.webhookPort}/`,
      );
    });

    this.api.on('shutdown', () => {
      this.webhookServer?.close();
    });
  }

  private handleWebhook(request: IncomingMessage, response: ServerResponse): void {
    this.log.debug(`Webhook ${request.method} ${request.url} from ${request.socket.remoteAddress}`);

    if (!this.digitalGongEnabled) {
      response.statusCode = 200;
      response.end('Digital gong disabled');
      this.log.info('Doorbell press ignored (digital gong off)');
      return;
    }

    this.doorbellService
      .getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
      .updateValue(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

    response.statusCode = 200;
    response.end('Doorbell rang!');
    this.log.info('Doorbell rang (HomeKit notification triggered)');
  }

  private async initializeShelly(): Promise<void> {
    try {
      this.mechanicalGongEnabled = await this.shelly.isMechanicalGongActive();
      this.mechanicalGongService.updateCharacteristic(
        this.hap.Characteristic.On,
        this.mechanicalGongEnabled,
      );

      await this.shelly.setupDoorbell(
        this.homebridgeIp,
        this.webhookPort,
        this.mechanicalGongEnabled,
        this.autoOffDelay,
      );
      this.log.info(`Shelly at ${this.name} configured for doorbell use`);
    } catch (error) {
      this.log.error(
        `Failed to configure Shelly for "${this.name}". ` +
        `Check IP, auth, and network reachability. Error: ${String(error)}`,
      );
    }
  }
}
