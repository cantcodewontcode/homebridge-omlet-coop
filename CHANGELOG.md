# Changelog

## [0.9.9] - 2026-09-22

### Setup
- Added support for Omlet developer API keys, generated at smart.omlet.com/developers
- Plugin settings now offer a choice of connection method: developer API key or Omlet account
- Once connected, the settings page shows the connected device instead of the setup form, with a Disconnect option
- Discovered device details now include whether a coop light is fitted and the power source

### Credentials
- Credentials are stored in the Homebridge storage directory instead of config.json
- Email address, password and API key are removed from config.json once a credential has been verified and saved
- A credential supplied in config.json by hand is still accepted; it is moved to storage on first successful use
- An invalid credential is left in config.json so it can be corrected

### Accessories
- The coop light accessory is auto-discovered and re-checked on every poll
- The battery accessory is shown only when the door is running on batteries; it is never shown for a mains-powered door
- Both settings default to automatic, with manual overrides in Advanced Settings
- Obstruction is reported to HomeKit when the door reports a blocked fault

### Reliability
- Open and close commands are no longer sent when the door is already in the requested state
- Polling drops to 5 second intervals while the door or light is moving, and returns to the configured interval once settled
- Light commands issued while the door is moving are held and sent once it stops
- A light left in a stuck pending state is settled automatically
- The plugin recovers when a saved device ID no longer exists on the account
- Replacing a coop keeps the existing HomeKit accessory rather than creating a new one

### Fixes
- United Kingdom now uses the country code GB, matching Omlet. UK is accepted and translated
- Added Spain, Norway and Poland to the country list
- Door states reported while moving are handled correctly; previously they showed as stopped
- Poll interval no longer saves an out of range or empty value
- Repeated authentication failures no longer fill the log, and polling stops until credentials are fixed
- Accessories report as unreachable using the HomeKit status rather than throwing
- Login requests send the correct Content-Length for non-ASCII passwords
- API tokens are no longer written to the log in debug mode

## [0.9.7] - 2026-02-18
- Fixed config schema: moved required fields to object-level array per JSON Schema spec

## [0.9.6] - 2026-02-17
- Verified Homebridge 2.0 compatibility
- Updated minimum Node.js requirement to v20

## [0.9.5] - 2026-02-17
- Fixed minor bugs and further streamlined console logging
- Streamlined code comments
- Poll cycle errors log even without debug

## [0.9.4] - 2026-02-17
- Cleaned default console logging
- Hid verbose logging fully behind debug flag
- Eager re-poll adjustments based on door timing

## [0.9.3] - 2026-02-17
- Fixed showstopper bug in device ID auto-discovery
- Consolidated API polling — all services now share a single poll cycle and cache instead of making individual API calls per service
- Reduced API calls to 1 per poll cycle

## [0.9.2] - 2026-02-16
- Added re-login retry logic on authentication failures (up to 3 attempts before permanent failure)
- Improved error handling and user-facing error messages throughout
- Refined config UI validation and feedback

## [0.9.1] - 2026-02-16
- Refactored to linked services pattern — door is the primary service, light and battery are linked
- Fixed Save button integration in the Homebridge config UI
- Eager re-poll after user commands to confirm state changes in HomeKit

## [0.9.0] - 2026-02-16
- Complete input validation for all config fields (email, token, device ID, hostname, poll interval)
- Stored credentials now take priority over config file values on startup
- Smart credential handling — token-only mode and email/password mode both fully supported

## [0.8.0] - 2026-02-16
- Added custom Homebridge UI with automatic login and device discovery. No manual token or device ID retrieval needed for most users.
- Auto-discovers single device, prompts for device ID selection if multiple devices found

## [0.7.0] - 2026-02-15
- Initial release
