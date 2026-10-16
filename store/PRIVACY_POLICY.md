# Privacy Policy — Audio Volume Limiter

Last updated: October 17, 2026

## Summary

Audio Volume Limiter processes audio entirely on your device. It does not record, store, or transmit audio or personal data outside your device.

## Data the extension accesses

- **Tab audio streams:** Accessed only for tabs where you explicitly enable limiting. Audio is processed in real time and immediately returned to your speakers; it is never written to disk or persistent storage.
- **Settings:** Ceiling, master-volume, and preset settings are stored only in `chrome.storage.local` on your device.
- **Tab labels:** Used only to identify limited tabs in the popup and never transmitted.

## What the extension does not do

- Send data to servers or make network requests.
- Use analytics or advertising.
- Sell or share data with third parties.
- Load external code.

## Permission justification

| Permission | Why it is needed |
|---|---|
| `tabCapture` | Captures audio from user-enabled tabs for level limiting. |
| `offscreen` | Creates a document to process audio with the Web Audio API. |
| `storage` | Saves the selected ceiling, master volume, and preset. |
| `activeTab` | Grants access to a tab after you click the extension icon or use its shortcut. |
| `alarms` | Periodically checks that limiting remains active and attempts recovery. |
| `scripting` | Injects the bundled media-volume lock script into user-enabled tabs. It does not read page content or use the network. |

## Contact

[Add your contact email here]
