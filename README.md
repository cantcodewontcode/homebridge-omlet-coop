# HomeBridge Omlet

Control your Omlet Smart Automatic Chicken Coop Door through Apple HomeKit.

This Homebridge plugin allows you to control your Omlet coop door and coop light directly from the Apple Home app, Siri, and HomeKit automations.

## Features

- **Easy Setup**: Custom configuration interface with automatic login and device discovery
- **Coop Door Control**: Open, close, and monitor your Omlet door (as a garage door) in HomeKit
- **Light Control**: Turn your coop light on and off (optional, requires Omlet Coop Light module)
- **Real-time Status**: Automatic polling to keep door and light status up to date
- **HomeKit Integration**: Full integration with Apple HomeKit scenes and automations
- **HomeBridge 2.0 compatible**

## Requirements

- Omlet Smart Automatic Chicken Coop Door
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

Your API key is stored in your Homebridge config, and your coop and accessories are auto-discovered.

### Option 2: Omlet account

This is the simplest setup option, and does not require the manual generation of an API key.

1. In Homebridge plugin settings, choose **Omlet account**.
2. Enter your email address and password, and select your country.
3. Click **Login**.

Logging in will generate an Omlet API key which is stored in your Homebridge config, and your coop and accessories are auto-discovered. This method impersonates the login process used by the official Omlet mobile app, and therefore the API key generated is not visible in the Omlet Developer console and cannot be revoked.

### Advanced Settings

Rarely needed:

- **API Server**: Override the default API server hostname (if ever needed)
- **Poll Interval**: Reduce how often the plugin checks device status (minimum: 30 seconds)
- **Debug Mode**: Enable detailed logging for troubleshooting

### Password Handling

When signing in with email address and password, your credentials are never saved to `config.json`. The plugin obtains a token and stores it instead. If you have upgraded from an older version, any password already in your config is scrubbed automatically the next time the plugin starts.

Because no password is kept, a token that stops working cannot be refreshed on its own. If that happens the accessory shows **No Response** in the Home app, and opening the plugin settings will tell you the session has expired. Complete the sign-in process again to restore your accessories.

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
      "apiKey": "YOUR_DEVELOPER_API_KEY",
      "bearerToken": "YOUR_API_TOKEN",
      "pollInterval": 30,
      "enableLight": true,
      "debug": false
    }
  ]
}
```

**Note:** At minimum, you must provide one of:
- **Email address and password** — the plugin logs in, saves a token, and then
  removes the password from `config.json` on its next start, OR
- **Developer API key** (`apiKey`) — used in preference to everything else, OR
- **API token** (`bearerToken`)

Set `enableLight` to `false` if you do not have the Omlet Coop Light module installed.

### Multiple Devices

Your coop door is found automatically — there is nothing to configure.

If you have more than one door on your account, the plugin uses the first one it
finds and lists the others in the Homebridge log at startup. If that is not the door
you want, please [open an issue](https://github.com/cantcodewontcode/homebridge-omlet-coop/issues)
and say so.

## Usage

After configuration, accessories will appear in your Home app:

1. **Coop Door** - A garage door that controls your coop door
2. **Coop Light** - A lightbulb that controls your coop light (if enabled)

You can use them fully like any other HomeKit accessory.

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

### Door status not updating

- Check the Poll Interval setting (minimum 30 seconds)
- Verify network connectivity between Homebridge and the Omlet API
- Enable Debug Mode to see polling activity in the logs

### Accessory shows "No Response" / session expired

Because your password is not stored, the plugin cannot silently log in again if its
saved token stops working.

- Open the plugin settings. If the session has expired, a message at the top will say so
- Enter your password and click **Login** to get a new token, then restart Homebridge
- If you are using a Developer API key, the key has been revoked — generate a new one
  at [smart.omlet.com/developers](https://smart.omlet.com/developers) and paste it in
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
