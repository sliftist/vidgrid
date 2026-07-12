// Sidebar chip that links to the Hey Google page and reflects remote-control
// state through color and label. The rotating-rainbow "being controlled" look
// animates a CSS custom-property angle on a conic-gradient border; the
// @property + @keyframes for that live in the <style> rendered here (there is
// no global stylesheet to hang them on, and this is the only consumer).

import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { page } from "../router";
import { heygoogleEnabled } from "../appState";
import { hgStatus, listDevices, listAccounts } from "./client";
import { chipDim, hgChipPurple, hgChipGreen, hgChipYellow, hgChipControlled, buttonDown } from "../styles";
import { playSound } from "../sounds";

// While the search page is open, refresh just the data this chip reflects.
const POLL_MS = 60_000;

const RAINBOW_CSS = `
@property --hg-angle { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
@keyframes hg-spin { to { --hg-angle: 360deg; } }
`;

type ChipState = "disabled" | "controlled" | "controllingOn" | "controllingOff" | "allowsControl" | "default";

function chipState(): ChipState {
    if (!heygoogleEnabled.get()) return "disabled";
    if (hgStatus.beingControlled) return "controlled";
    if (hgStatus.devices.some(d => d.connected)) return "controllingOn";
    if (hgStatus.devices.length > 0) return "controllingOff";
    if (hgStatus.accounts.length > 0) return "allowsControl";
    return "default";
}

function chipClass(state: ChipState): string {
    switch (state) {
        case "disabled": return chipDim;
        case "controlled": return hgChipControlled;
        case "controllingOn": return hgChipGreen;
        case "controllingOff": return hgChipYellow;
        default: return hgChipPurple;
    }
}

function chipLabel(state: ChipState): string {
    const on = hgStatus.devices.filter(d => d.connected).length;
    switch (state) {
        case "disabled": return "Hey Google";
        case "controlled": return "Being remote controlled";
        case "allowsControl": return "Being remote controlled";
        case "controllingOn": return `Connected · controlling remote (${on} on)`;
        case "controllingOff": return "Controlling remote (off)";
        default: return "Hey Google";
    }
}

@observer
export class HeyGoogleChip extends preact.Component {
    private timer: number | undefined;

    componentDidMount() {
        this.poll();
        this.timer = window.setInterval(() => this.poll(), POLL_MS);
    }

    componentWillUnmount() {
        if (this.timer !== undefined) window.clearInterval(this.timer);
    }

    private poll() {
        if (!heygoogleEnabled.get()) return;
        void listDevices().catch(() => { /* chip is best-effort */ });
        void listAccounts().catch(() => { /* chip is best-effort */ });
    }

    render() {
        const state = chipState();
        return <>
            {state === "controlled" && <style>{RAINBOW_CSS}</style>}
            <button
                className={chipClass(state)}
                onMouseDown={buttonDown(() => { playSound("heyGoogle"); page.value = "heygoogle"; })}
                title="Hey Google — voice control, devices, and Google Home linking"
            >
                {chipLabel(state)}
            </button>
        </>;
    }
}
