
# HomeBridge Omlet

Control your Omlet Smart Automatic Chicken Coop Door and Feeder through Apple HomeKit.

This Homebridge plugin allows you to control your Omlet coop doors, lights, and feeders directly from the Apple Home app, Siri, and HomeKit automations.

## Features

- **Easy Setup**: Custom configuration interface with automatic login and device discovery
- **Coop Doors**: Open, close, and monitor all of your Omlet doors in HomeKit
- **Smart Feeders**: Monitor the status of your Smart feeders
- **Light Control**: Turn your coop light on and off (requires Omlet Coop Light module)
- **HomeKit Integration**: Full integration with Apple HomeKit scenes and automations
- **HomeBridge 2.0 compatible**

## Requirements

- Omlet Smart Automatic Chicken Coop Door or Smart Feeder
- Omlet Wi-Fi Module
- Omlet Coop Light (optional, for light integration)
- Homebridge v1.6.0 or later
- Node.js v20.0.0 or later

## Installation

### Homebridge web interface

1. Search for **homebridge-omlet** in the Homebridge UI plugin search
2. Click **Install**
3. Click **Settings** to configure the plugin

### Command line

```bash
npm install -g homebridge-omlet
```

## Configuration

Open **Plugin Settings** in the Homebridge web interface and pick one of two ways to connect.

### Option 1: Developer API key

This is the recommended setup method, and the one officially supported by Omlet.

1. Go to [smart.omlet.com/developers/login](https://smart.omlet.com/developers/login) and login with your Omlet email address and password.
2. Open **API Keys** and click **Generate Key**, then copy it.
3. In Homebridge plugin settings, choose **Developer API key**, paste the key, and click **Login**.

Your coop and accessories are auto-discovered, and the key is saved to the Homebridge storage directory rather than `config.json`.

### Option 2: Omlet account

This is the simplest setup option, and does not require the manual generation of an API key.

1. In Homebridge plugin settings, choose **Omlet account**.
2. Enter your email address and password, and select your country.
3. Click **Login**.

Logging in generates an Omlet API key, which is saved to the Homebridge storage directory rather than `config.json`. Your coop and accessories are auto-discovered. This method impersonates the login process used by the official Omlet mobile app, so the key it generates is not visible in the Omlet Developer console and cannot be revoked.

### Global Settings

Applied to every device, unless overridden on a specific device:

- **Coop lights**: Auto-discover, or never display
- **Batteries**: Auto-discover, always display, or never display
- **Light sensors**: Off by default, or set to auto-discover

### Per-Device Settings

Each device has its own section where any of its settings can be customized, or individual devices can be hidden from HomeKit entirely.

Also, for a door with a coop light, you can override the light-off setting to a maximum of 60 minutes (vs. the 10 minute maximum allowed in the Omlet app).

### Advanced Settings

Rarely needed:

- **API Server**: Override the default API server hostname (if ever needed, currently Omlet has a single global server)
- **Poll Interval**: Reduce how often the plugin checks device status. One request covers every device on your account, so this does not change with the number of doors
- **Remove accessories not seen for**: How long a device may be missing from your Omlet account before its accessory is removed from HomeKit. Default 24 hours; 0 to disable.
- **Debug Mode**: Enable detailed logging for troubleshooting
- **Capture device payload**: Fetches one response from your own Omlet account, for easy pasting into a GitHub issue report. All sensitive fields are auto-mased for privacy reasons.

### Re-authenticate and Reset Plugin

Once you are connected, the settings page offers two buttons.

**Re-authenticate** forces a resauthentication, while preserving all plugin configuration.

**Reset Plugin** clears the plugin configuration entirely, allowing you to sign in again from scratch. (No need to delete the plugin and reinstall to wipe.)

#### Light Level Sensor

The plugin can display the light sensor values from Omlet doors and Smart feeders both. Apple Home app displays light values in lux, but Omlet uses a proprietary range of 0-100, so the value is technically incorrect, but still useful for light-based automations.

### Credential handling

Your API key is written to the Homebridge storage directory, not to `config.json`. Your email address and password are never saved anywhere: they are used once to obtain a key and then discarded.

If credentials or API keys are hand coded into `config.json`, upon successful sign in, those values are wiped and the API key is stored in the Homebridge storage directory.

If you upgrade from an older version, any password or key sitting in your config is removed automatically the first time the plugin re-connects.

If a key or session should ever expire, you will be prompted to sign-in again when opening the plugin.

### Config.json Example (Alternative Method)

If you prefer to edit `config.json` directly:

```json
{
  "platforms": [
    {
      "platform": "OmletCoop",
      "name": "Omlet Coop",
      "email": "YOUR_EMAIL_ADDRESS",
      "password": "YOUR_PASSWORD",
      "countryCode": "US",
      "apiServer": "x107.omlet.co.uk",
      "bearerToken": "YOUR_DEVELOPER_API_KEY",
      "pollInterval": 30,
      "enableLight": true,
      "debug": false
    }
  ]
}
```

**Note:** At minimum, you must provide one of:
- **Developer API key** (`bearerToken`), OR
- **Email address and password**

### Multiple Devices

All of your Omlet smart devices are found automatically. Device inherit global settings by default, but each devices settings can be individually customized to suit your needs. Any devices deviating from default settings are badged for easy identification.

Devices can be disabled, which removes them from HomeKit. If the device is later re-enabled Home treats it like a new device, so it will need to be manually re-added to automations etc.

Omlet coop doors display in Home as garage doors, and feeders display as contact sensors. Coop lights, device light sensors, and battery levels display as properties of the same accessory. If you prefer to have individual accessories for the various properties, the Home app allows you to easily show each component as its own tile.

For feeders specifically, you can have the feed level display as the Home accessory's battery level if you prefer this to showing the true battery level.

## Troubleshooting

### Plugin doesn't start

- Verify your Omlet account credentials are correct
- Check that your Omlet device has internet connectivity via the Wi-Fi module
- Enable **Debug Mode** in Advanced Settings to see detailed logs
- Check Homebridge logs for error messages

### Accessories not responding

- Verify your Omlet device has internet connectivity
- Check Homebridge logs for authentication errors
- Try restarting Homebridge
- Check for proper functionality in the official Omlet app

### Door status not updating

- Check the Poll Interval setting (minimum 30 seconds)
- Verify network connectivity between Homebridge and the Omlet API
- Enable Debug Mode to see polling activity in the logs

### Accessory shows "No Response" / session expired

Because your password is not stored, the plugin cannot silently log in again if its saved key stops working.

- Open the plugin settings. If the session has expired, a message at the top will say so
- Enter your password and click **Login** to get a new token, then restart Homebridge
- If you are using a Developer API key, the key has been revoked — generate a new one   at [smart.omlet.com/developers](https://smart.omlet.com/developers) and paste it in
- Check the Homebridge log for the specific authentication error

## Support

For issues, questions, or feature requests, please [open an issue on GitHub](https://github.com/cantcodewontcode/homebridge-omlet-coop/issues).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Credits

Developed by Bill Spry

Thanks to the Homebridge community for their excellent documentation and support, and to Omlet for supporting our backyard chickens.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

The Homebridge Omlet plugin controls your chicken coop door. By using this plugin, you accept sole responsibility for the safety of your flock. Always verify your coop door is functioning correctly and never rely solely on this plugin. This plugin is not affiliated with, endorsed by, or supported by Omlet Ltd.
