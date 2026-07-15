import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { formatTime } from "socket-function/src/formatting/format";
import { victimDecoding, victimCurrentFile, victimStartMs } from "./decodeService";
import { chipScan } from "../styles";

// Shown bottom-right (before the build number) in the tab the coordinator has
// appointed to decode — i.e. this tab is actively doing background scan work
// right now. Hover shows how long it's been scanning and which file. A 1s ticker
// keeps the elapsed time in the title live.
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
        this.tick.get(); // re-render every second so the title stays current
        if (!victimDecoding.get()) return null;
        const file = victimCurrentFile.get();
        const elapsed = Math.max(0, Date.now() - victimStartMs.get());
        const title = `This tab is doing background scanning — ${formatTime(elapsed)} on ${file || "(a file)"}`;
        return <span className={chipScan + css.pointerEvents("auto").cursor("default")} title={title}>
            scanning…
        </span>;
    }
}
