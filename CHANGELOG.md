# Changelog

## [1.0.0] - 2026-10-20

### Door Updates
- Added support for multiple Omlet coop doors. Adjust light, battery, and light level settings globally or per-door. (Requested by @stevendark-TSD, #6)
- Devices now match based on their serial, allowing device matching after a factory reset.
- Disable a door to hide it from HomeKit. (If a device is disabled and then enabled, it appears as a new device in Apple Home.)
- **On upgrade from a prior version**, only the existing coop door will show in Apple Home. If you have additional coop doors, simply enable them in plugin settings. (On new installations, all doors add to Apple Home by default.)
- A door added to your account appears on the next poll, without needing a plugin restart.
- Optionally expose the door's light sensor. This will show in Apple Home as a lux value, but it is actually an Omlet-proprietary value of 0-100. Useful for triggering light-based automations.

### Feeders
- Added support for Omlet Smart Feeders! (Requested by @stevendark-TSD, #6)
- Feeders appear as contact sensors, which can be customized in Apple Home to appear as a sensor, door, or other device type. Monitor when feeders are open or closed, along with any faults.
- Feeders are read-only. The Omlet app controls them on a schedule and does not provide an "open" or "close" command on-demand.
- By default, feeders report battery level and this will display as the contact sensor's battery level.
- For users who prefer, feed level can be reported as the feeder accessory battery level (instead of showing the actual battery level). Choose between mapping feed level or battery level to the Apple Home accessory battery level.
- Feeders have their own ambient light sensor, separate from the coop light, and it can be exposed the same way a door's is — globally or per-feeder. This is the sensor that opens the feeder on daylight when its mode is set to light rather than time.
- A feeder checks in with Omlet only periodically, so its state is not live in the same way a door's state is live. It is possible for state reporting to be delayed.

### Security
- Debug mode no longer logs account passwords on initial plugin setup.
- Debug mode no longer logs any part of your API key.
- Debug mode no longer prints the full device payload when visiting plugin settings.

### Settings
- Coop lights, batteries and light sensors have moved out of advanced settings into a **Global Settings** section above the device list, since they decide what each device publishes. Advanced settings now holds only API server, poll interval, accessory removal, debug logging and payload capture.
- Per-device dropdowns now read "Use global setting" rather than "Use the plugin setting".
- Added a maximum light on time setting to each door with a coop light. The Omlet app only allows up to 10 minutes; this extends it to as much as 60 minutes. It is pushed to the device as a one-time event, so if the setting is later adjusted in the Omlet app you can return and set it again.
- The settings page now lists every device on the account, with its type and serial.
- A new **Re-authenticate** button allows users to force a fresh re-authentication while preserving all plugin config.
- A new **Reset Plugin** button allows users to wipe all plugin configuration without requiring the plugin to be deleted and reinstalled.
- A new **Capture device payload** button in advanced settings captures a single full payload response from Omlet API, and displays it for easy copy/paste. This is useful for troubleshooting issues with the plugin. The function automatically removes sensitive information like device name and wi-fi name.
- The system now automatically removes accessories not seen for 24 hours. The number of hours can be adjusted or set to 0 to disable. This allows devices to automatically be dropped after they are removed from your setup, and also allows devices which are factory reset to be preserved in Apple Home with their existing settings.
- Removed the Device ID field from settings, given that all accessories are now discovered.

### Reliability
- One request covers every device on the account, reducing the impact on Omlet's servers.
- Initial startup and discovery now use a single API call.

### Bug Fixes
- A coop that cannot be found on the account is now reported once rather than on every poll.

## [0.9.9] - 2026-10-01

### Setup
- Setup adds support for the official Omlet developer API keys. This is the only officially-supported sign-in method from Omlet, and keys can be managed and revoked on their portal.
- If a coop is factory reset or replaced, the HomeKit accessories are preserved by the replacement coop (or reset coop), instead of appearing as a new coop.

### Security Enhancements
- Omlet account email and password are no longer stored in config. Existing credentials are cleared on upgrade.
- API keys in config.json are moved on upgrade to the recommended storage locations.
- It is still possible to manually add email address, password, or bearerToken to the config.json file, but once login is validated, the credentials are removed from the config.
- API tokens are no longer written to the log in debug mode.

### Accessories
- The coop light accessory is now auto-discovered at setup and periodically, so if you add the light later, Homebridge auto-adds it (and vice versa). The light accessory can still be manually disabled in advanced settings.
- The battery accessory is shown only when the door is actually running on batteries, never for a plugged-in unit.
- Obstruction is now reported to HomeKit when the door reports a blocked fault.

### Omlet Server Reliability
- Workaround implemented for a known Omlet server issue wherein a command to put an accessory in the state it is already in can cause a "stuck pending" state for the accessory. (For example, sending a command to open an already-open door causes the door to stick in a "pending open" state for ~1 hour):
  - When sending a command to an accessory, the existing state is checked, and the command is aborted if the accessory is already in the correct state.
  - When an accessory is detected as being in a stuck state (i.e. "pending" for over 90 seconds) the system auto-flips the accessory. (For example, if stuck in "pending on" state, the system forces an "off" command followed by an "on" command.)
- Authentication failures no longer stop the plugin permanently. After three failed attempts it progressively backs off on attempts, settling at hourly attempts until authentication succeeds. A temporary Omlet outage or a network problem no longer needs a Homebridge restart to recover from. (Reported by @kylemhall, #4)
- Connection problems and Omlet server errors now back off in the same way, each on its own schedule: a dropped network retries quickly and recovers fast, while repeated server errors slow to periodic checks instead of filling the log.

### Performance Improvements
- 5-second polling interval when the door or light state is changing, to more quickly confirm when the door has finished opening or closing.
- Improved handling of door states in motion.

### Bug Fixes
- Added Spain, Norway, and Poland country support, and corrected United Kingdom entry.
- Poll interval no longer saves an out-of-range or empty value.
- Accessories report as unreachable using the proper HomeKit status instead of throwing.
- Login requests send the correct Content-Length for non-ASCII passwords.
- Clearer and more consistent wording on setup, migration, and door and light log messages.
- A request that times out is no longer reported twice.
- After a coop is replaced or factory reset, the "device ID changed" notice is logged once rather than on every restart.
- A replacement coop is only adopted automatically when there is exactly one other door on the account. With more than one the plugin asks you to choose in settings instead of guessing, so an existing accessory can never end up controlling a different door.

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
