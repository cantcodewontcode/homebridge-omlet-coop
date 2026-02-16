# homebridge-omlet-coop

Control your Omlet Smart Automatic Chicken Coop Door through Apple HomeKit.

This Homebridge plugin allows you to control your Omlet Autodoor and coop light directly from the Apple Home app, Siri, and HomeKit automations.

## Features

- **Coop Door Control**: Open, close, and monitor your Omlet Autodoor as a garage door in HomeKit
- **Light Control**: Turn your coop light on and off
- **Real-time Status**: Automatic polling to keep door and light status up to date
- **HomeKit Integration**: Full integration with Apple HomeKit scenes and automations

## Requirements

- Omlet Smart Automatic Chicken Coop Door
- Omlet Wi-Fi Module (required for internet connectivity)
- Homebridge v1.6.0 or later
- Node.js v18.0.0 or later

## Installation

### Via Homebridge UI (Recommended)

1. Search for "homebridge-omlet-coop" in the Homebridge UI plugin search
2. Click **Install**
3. Configure the plugin (see Configuration section below)

### Via Command Line

```bash
npm install -g homebridge-omlet-coop
```

## Configuration

### Getting Your Bearer Token and Device ID

**Note:** Obtaining these values requires using the command line. A simplified setup process is planned for future releases.

#### Using API Login (Recommended)

**Step 1: Get your bearer token**

```bash
curl -X POST https://x107.omlet.co.uk/api/v1/login \
  -H "Content-Type: application/json" \
  -d '{"emailAddress":"your@email.com","password":"yourpassword","cc":"US"}'
```

The response will contain your `apiKey` - this is your bearer token:
```json
{"apiKey":"your_token_here"}
```

**Step 2: Get your device ID**

```bash
curl -s https://x107.omlet.co.uk/api/v1/group \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

Look for your device in the response. The `deviceId` field is what you need.

### Config.json Example

Add this to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "OmletCoop",
      "name": "Omlet Coop",
      "bearerToken": "YOUR_BEARER_TOKEN_HERE",
      "deviceId": "YOUR_DEVICE_ID_HERE",
      "pollInterval": 30,
      "debug": false
    }
  ]
}
```

### Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `platform` | Yes | - | Must be `OmletCoop` |
| `name` | Yes | `Omlet Coop` | Name for this plugin instance |
| `bearerToken` | Yes | - | Your Omlet API bearer token |
| `deviceId` | Yes | - | Your Omlet device ID |
| `apiServer` | No | `x107.omlet.co.uk` | API server hostname (advanced users only) |
| `pollInterval` | No | `30` | How often to check status (in seconds, minimum 10) |
| `debug` | No | `false` | Enable detailed logging |

## Usage

After configuration, two accessories will appear in your Home app:

1. **Coop Light** - A lightbulb that controls your coop light
2. **Coop Door** - A garage door that controls your autodoor

You can:
- Control them via the Home app
- Use Siri voice commands ("Hey Siri, open the coop door")
- Add them to HomeKit scenes and automations
- Control them from Apple Watch, Mac, or other HomeKit devices

## Troubleshooting

### Plugin doesn't start

- Check your bearer token and device ID are correct
- Enable debug mode (`"debug": true`) to see detailed logs
- Check Homebridge logs for error messages

### Accessories not responding

- Verify your Omlet device has internet connectivity via the Wi-Fi module
- Check if your token has expired (tokens expire after ~15 days)
- Try restarting Homebridge

### Door status not updating

- Increase the poll interval if you're experiencing rate limiting
- Check network connectivity between Homebridge and the Omlet API

## Known Limitations

- Bearer tokens expire after approximately 15 days and must be manually refreshed
- Only supports one device per platform instance
- Auto-login not yet implemented (planned for v1.0)

## Roadmap

### v1.0 (Planned)
- Automatic login using email/password
- Automatic token refresh
- Device auto-discovery
- Better error handling and recovery

### Future Versions
- Support for multiple devices
- Battery level monitoring
- Door scheduling via HomeKit
- Push notifications for door events

## Support

For issues, questions, or feature requests, please [open an issue on GitHub](https://github.com/cantcodewontcode/homebridge-omlet-coop/issues).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Credits

Developed by Bill Spry

Special thanks to the Homebridge community for their excellent documentation and support.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This plugin is not affiliated with, endorsed by, or connected to Omlet Ltd. Use at your own risk.
