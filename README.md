# homebridge-shelly-plus1-doorbell

Homebridge plugin that turns a [Shelly Plus 1](https://www.shelly.com/products/shelly-plus-1) wired to a classic two-wire doorbell into a HomeKit doorbell with:

- **Native HomeKit doorbell notifications** (phone push + HomePod doorbell sound)
- **Digital gong** switch — mute notifications without affecting the physical chime
- **Mechanical gong** switch — mute the physical chime (relay detached) while still getting digital notifications

Inspired by [jeppesens/homebridge-shelly-doorbell](https://github.com/jeppesens/homebridge-shelly-doorbell) and [ca-iot/homebridge-shelly-doorbell](https://gitlab.com/ca-iot/homebridge-shelly-doorbell), rewritten for Shelly Gen2 RPC with a correct webhook `cid` and an explicit digital mute switch.

## How it works

1. The doorbell button is wired to the Shelly **SW** input.
2. The mechanical gong is powered through the Shelly **relay** (I / O).
3. On button press, Shelly fires a Gen2 webhook to Homebridge.
4. The plugin updates `ProgrammableSwitchEvent` on a HomeKit `Doorbell` service.
5. If Mechanical Gong is on, the relay pulses briefly (`momentary` + auto-off). If off, input mode is `detached` so the relay stays open.

```
Button ──► Shelly SW ──webhook──► Homebridge ──► HomeKit notification
                │
                └── relay (I/O) ──► Mechanical gong (optional)
```

## Hardware / wiring

**If you are not qualified to do electrical work, use a licensed electrician.**

Typical setup (same pattern as the upstream doorbell plugins):

- Power the Shelly Plus 1 from a suitable **low-voltage DC** supply appropriate for your doorbell circuit (commonly 12 V DC in published examples).
- Doorbell **button** → Shelly **SW** (and shared common / ground per Shelly docs).
- Mechanical **gong** load through Shelly relay terminals **I** and **O**.
- Do **not** put mains / high voltage on thin doorbell wires.

Also:

1. In the Shelly web UI, disable **Settings → Factory reset → Enable factory reset from switch** so a long button press cannot reset the device.
2. Give the Shelly a **static DHCP reservation** (or static IP).
3. Ensure the Shelly can reach your Homebridge host on the webhook port (same LAN / no client isolation).

## Install

Search for **Shelly Plus 1 Doorbell** in the Homebridge UI, or:

```bash
hb-service add homebridge-shelly-plus1-doorbell
```

Restart Homebridge after install.

### From source

```bash
git clone https://github.com/rahouse/homebridge-shelly-plus1-doorbell.git
cd homebridge-shelly-plus1-doorbell
npm install
npm run build
npm link
```

## Configuration

Example `config.json` platform block:

```json
{
  "platforms": [
    {
      "platform": "ShellyPlus1Doorbell",
      "name": "Shelly Plus 1 Doorbell",
      "homebridgeIp": "192.168.1.10",
      "doorbells": [
        {
          "name": "Front Door",
          "shellyIp": "192.168.1.50",
          "webhookPort": 9053,
          "shellyPassword": "optional-if-auth-enabled",
          "digitalDoorbellName": "Digital gong",
          "mechanicalDoorbellName": "Mechanical gong",
          "autoOffDelay": 0.2
        }
      ]
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `homebridgeIp` | yes | LAN IP of Homebridge (what the Shelly will call) |
| `doorbells[].name` | yes | Accessory name in Home |
| `doorbells[].shellyIp` | yes | Shelly Plus 1 IP |
| `doorbells[].webhookPort` | yes | Local listen port (unique per doorbell) |
| `doorbells[].shellyPassword` | no | Gen2 auth password (`admin` username) |
| `doorbells[].autoOffDelay` | no | Relay pulse seconds (default `0.2`) |

On startup the plugin configures the Shelly:

- `Input.SetConfig` → button
- `Webhook.Create` / `Update` → `input.button_push`, **`cid: 0`**, URL `http://<homebridgeIp>:<webhookPort>/`
- `Switch.SetConfig` → `momentary` or `detached` from Mechanical Gong state, with short auto-off

## Home app controls

After restart you should see one accessory with:

| Control | On | Off |
|---------|----|-----|
| **Digital gong** | Button press → HomeKit doorbell notification / HomePods | Webhook ignored (no notification) |
| **Mechanical gong** | Relay pulses with the button | Input detached — no physical gong |

Use both off for silence, digital-only for notifications without waking the house, etc. Automate the switches with HomeKit scenes (Good Night, Away, …).

> The Doorbell service itself may look limited in the Home app UI; notifications and HomePod chimes still fire. Apps like Eve or Controller can expose more of the doorbell characteristic for automations.

## Verification checklist

1. **Webhook path (without the button)**  
   From any machine on the LAN:
   ```bash
   curl http://<homebridgeIp>:9053/
   ```
   You should get `Doorbell rang!` and a HomeKit doorbell notification / HomePod chime (with Digital Gong on).

2. **Mechanical on** — Press the physical button → gong sounds + notification.

3. **Mechanical off** — Turn Mechanical Gong off in Home → press button → notification only, no relay click.

4. **Digital off** — Turn Digital Gong off → press button → no notification; mechanical still follows its switch.

5. **Shelly UI** — Open the Plus 1 web UI → **Webhooks / Actions** and confirm a hook named `Homebridge Doorbell` pointing at `http://<homebridgeIp>:<port>/`. Trigger the button and confirm the hook runs successfully (no connection errors).

### If notifications fail but the relay works

- Confirm `homebridgeIp` is the address the **Shelly** can route to (not `127.0.0.1`, not a Docker-internal IP unless the Shelly shares that network).
- Confirm the webhook port is open on the Homebridge host firewall.
- Check Homebridge logs for `Digital doorbell webhook listening` and `Doorbell rang`.
- Uninstall conflicting doorbell plugins and remove stale cached accessories if needed.

## Uninstall conflicting plugins

Remove `homebridge-shelly-doorbell` / `homebridge-shelly-doorbell-plus` before using this plugin so ports and HomeKit accessories do not collide.

## Safety note

This plugin configures network and relay behavior of a device that may switch a doorbell transformer/gong. Use appropriate voltage, follow Shelly ratings, and involve an electrician when unsure.

## License

MIT
