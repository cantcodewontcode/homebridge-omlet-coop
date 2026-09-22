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
- Homebridge v1.6.0 or later (Homebridge 2.0 compatible)
- Node.js v20.0.0 or later

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

Open **Plugin Settings** in the Homebridge UI and pick one of two ways to connect.
Either works fully; they differ in setup effort and in how much control you keep.

|                                   | Developer API key | Omlet account |
|-----------------------------------|:-----------------:|:-------------:|
| Officially supported by Omlet     | Yes               | No            |
| You can revoke access later       | Yes               | No            |
| Password typed into Homebridge    | Never             | Once, at setup |
| Setup effort                      | Generate a key first | Just log in |

Whichever you choose, your coop door is discovered automatically and your password is
never written to `config.json`.

### Option 1: Developer API key

Recommended if you are comfortable generating a key. It is the method Omlet
officially documents, and you can revoke the key at any time from their console —
something you cannot do with a session created by logging in.

1. Go to [smart.omlet.com/developers](https://smart.omlet.com/developers) and log in
   with the same email address and password you use for the Omlet app
2. Open **API Keys** and click **Generate Key**, then copy it
3. In the plugin settings, choose **Developer API key**, paste it in, and click
   **Validate Key**

Keys are long-lived and do not expire on their own. If one stops working it has been
revoked, and you will need to generate a new one.

### Option 2: Omlet account

The simplest route, and the right choice if you would rather not deal with the
developer console.

1. In the plugin settings, choose **Omlet account email and password**
2. Enter your email address and password, and select your country
3. Click **Login**

Your password is used once to obtain a token and is then discarded — see
[Password Handling](#password-handling) below.

### Advanced Settings

Rarely needed:

- **API Token**: Provide a token directly instead of logging in
- **API Server**: Override the default API server hostname (if ever needed)
- **Poll Interval**: Reduce how often the plugin checks device status (default: 30 seconds)
- **Debug Mode**: Enable detailed logging for troubleshooting

### Password Handling

Your password is never saved to `config.json`. When you log in, the plugin exchanges
it for a token and stores only that token, in the Homebridge storage directory. If
you have upgraded from an older version, any password already in your config is
removed automatically the next time the plugin starts.

Because no password is kept, a token that stops working cannot be refreshed on its
own. If that happens the accessory shows **No Response** in the Home app, and opening
the plugin settings will tell you the session has expired. Enter your password and
click **Login** again.

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

Setting up through the plugin settings screen is recommended, since it never writes
your password to `config.json` in the first place.

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
