# Changelog

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
