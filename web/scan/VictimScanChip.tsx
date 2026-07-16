import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatTime } from "socket-function/src/formatting/format";
import { victimDecoding, victimCurrentFile, victimStartMs } from "./decodeService";
import { isScanRunning, currentScanSnapshot } from "./scanStatusBus";
import { chipScan, chipDim } from "../styles";

// Shown beside the build info. Two states:
//   • "decoding…" — THIS tab is the one doing the actual scan work right now
//     (the coordinator appointed it; driven locally + instantly by decodeService).
//   • "scanning…" — some OTHER tab is doing the work (the background scan is
//     running, just not here).
// Hover on "decoding" shows elapsed time + current file. A 1s ticker keeps the
// elapsed time live.
@observer
export class VictimScanChip extends preact.Component {
    private tick = observable.box(0);
    private timer: ReturnType<typeof setInterval> | undefined;

    componentDidMount() {
        this.timer = setInterval(() => runInAction(() => this.tick.set(Date.now())), 1000);
    }
    componentWillUnmount() {
        if (this.timer) clearInterval(this.timer);
    }

    render() {
        this.tick.get(); // re-render every second so elapsed time stays current
        if (victimDecoding.get()) {
            const file = victimCurrentFile.get();
            const elapsed = Math.max(0, Date.now() - victimStartMs.get());
            const title = `This tab is decoding for the background scan — ${formatTime(elapsed)} on ${file || "(a file)"}`;
            return <span className={chipScan + css.pointerEvents("auto").cursor("default")} title={title}>decoding…</span>;
        }
        if (isScanRunning()) {
            const phase = currentScanSnapshot().phase;
            return <span className={chipDim + css.pointerEvents("auto").cursor("default")}
                title={`Background scanning (${phase}) is running in another tab`}>scanning…</span>;
        }
        return null;
    }
}
