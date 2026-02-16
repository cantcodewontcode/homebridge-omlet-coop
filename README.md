# HomeBridge Omlet

Control your Omlet Smart Automatic Chicken Coop Door through Apple HomeKit.

This Homebridge plugin allows you to control your Omlet coop door and coop light directly from the Apple Home app, Siri, and HomeKit automations.

## Features

- **Easy Setup**: Custom configuration interface with automatic login and device discovery
- **Coop Door Control**: Open, close, and monitor your Omlet door (as a garage door) in HomeKit
- **Light Control**: Turn your coop light on and off (optional, requires Omlet Coop Light module)
- **Real-time Status**: Automatic polling to keep door and light status up to date
- **HomeKit Integration**: Full integration with Apple HomeKit scenes and automations

## Requirements

- Omlet Smart Automatic Chicken Coop Door
- Omlet Wi-Fi Module
- Omlet Coop Light (optional, for light integration)
- Homebridge v1.6.0 or later
- Node.js v18.0.0 or later

## Installation

### Homebridge UI (Recommended)

1. Search for "homebridge-omlet" in the Homebridge UI plugin search
2. Click **Install**
3. Click **Settings** to configure the plugin using the interactive setup interface

### Command Line

```bash
npm install -g homebridge-omlet
```

## Configuration

1. **Open Plugin Settings** in Homebridge UI
2. **Enter your Omlet account email address and password**
3. **Select your country code**
4. **Click _Login_** - the plugin will automatically:
   - Authenticate with your Omlet account
   - Discover your coop door
   - Save the configuration

That's it! The plugin handles all the complexity behind the scenes.

### Advanced Settings

For advanced users, the plugin supports:

- **API Token**: Manually provide an API token instead of email/password
- **Device ID**: Manually specify a device ID (useful for multiple doors)
- **API Server**: Override the default API server hostname (if ever needed)
- **Poll Interval**: Reduce how often the plugin checks device status (default: 30 seconds)
- **Debug Mode**: Enable detailed logging for troubleshooting

#### Manual API Token and Device ID Retrieval

If preferred, you can manually retrieve your API token and device ID using the Omlet API:

**Step 1: Get your API token**
```bash
curl -X POST https://x107.omlet.co.uk/api/v1/login \
  -H "Content-Type: application/json" \
  -d '{"emailAddress":"your@email.com","password":"yourpassword","cc":"US"}'
```
The response will contain your `apiKey` (bearer token).

**Step 2: Get your device ID**
```bash
curl -s https://x107.omlet.co.uk/api/v1/group \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```
Look for your device in the response.

**Step 3: Configure the plugin**

Enter both the API Token and Device ID in the Advanced Settings section of the plugin configuration. The plugin will use these directly without requiring your email address and password. If you also enter your email address and password, these will be used in case the token should ever expire or become invalid.

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
      "bearerToken": "YOUR_API_TOKEN",
      "deviceId": "YOUR_DEVICE_ID",
      "pollInterval": 30,
      "enableLight": true,
      "debug": false
    }
  ]
}
```

**Note:** At minimum, you must provide either:
- **Email address and password** (for automatic token management), OR
- **API token** (for manual authentication)

Set `enableLight` to `false` if you do not have the Omlet Coop Light module installed.

### Multiple Devices

If you have multiple Omlet coop doors on your account:

1. During initial setup, the plugin will automatically select the first device
2. To use a different device, expand **Advanced Settings** and enter the specific **Device ID**
3. Device IDs are shown in the Homebridge logs during startup

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

### Token validation fails

- The plugin will automatically re-authenticate using your stored credentials
- If issues persist, try removing and re-adding your email/password in the plugin settings

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
