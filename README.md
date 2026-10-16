# Audio Volume Limiter

## Install for testing

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this folder.
3. Open a tab playing audio, click the extension icon, and turn on the switch.

## Features

- A brick-wall look-ahead limiter with a -60 to 0 dBFS ceiling.
- Shared master-volume control and Peak, RMS, and gain-reduction metering.
- Custom, Night mode, and Speech focus presets.
- Multiple tabs can be limited simultaneously after enabling them individually.
- Automatic recovery after an audio stream interruption.
- Website `<audio>` and `<video>` volume/mute controls are pinned while the limiter is enabled, so the extension is the audible volume controller.

## Notes

- Only tabs explicitly enabled by the user can be captured; Chrome does not allow automatic capture of all tabs.
- The limiter adds about 5 ms latency. Metering measures sample peaks, not true peaks.
- Websites using Web Audio `GainNode` rather than media-element controls may still adjust their source loudness.
- All audio processing takes place locally on your device.
