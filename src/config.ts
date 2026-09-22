export interface DoorbellConfig {
  name: string;
  shellyIp: string;
  webhookPort: number;
  shellyUsername?: string;
  shellyPassword?: string;
  digitalDoorbellName?: string;
  mechanicalDoorbellName?: string;
  autoOffDelay?: number;
}

export interface PlatformPluginConfig {
  name?: string;
  homebridgeIp: string;
  doorbells: DoorbellConfig[];
  platform: string;
}
