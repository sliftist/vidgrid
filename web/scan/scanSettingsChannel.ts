// Cross-context broadcast for the master "scanEnabled" toggle.
//
// scanEnabled lives in localStorage (Window-only), so the coordinator
// SharedWorker can't read it directly. Whoever flips it broadcasts on this
// channel; every tab updates its UI and the coordinator self-closes on
// disable (unless it was spawned with a one-shot allowance for "Scan Now").
// Senders don't hear their own messages, so no self-loop.

export const SCAN_SETTINGS_CHANNEL_NAME = "vidgrid-scan-settings";

export type ScanSettingsMsg = { type: "scanEnabled"; enabled: boolean };

export function openScanSettingsChannel(): BroadcastChannel {
    return new BroadcastChannel(SCAN_SETTINGS_CHANNEL_NAME);
}
