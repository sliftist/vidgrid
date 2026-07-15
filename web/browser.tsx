// STYLE: no rounded corners anywhere in this project — never call .borderRadius
// on any element. Keep edges sharp.

import * as preact from "preact";
import { reaction, IReactionDisposer } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css, isNode } from "typesafecss";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";
import { ensureFolder, files, disableThemeBackgrounds } from "./appState";
import { startScanClient } from "./scan/scanClient";
import { VictimScanChip } from "./scan/VictimScanChip";
import { currentVideo, searchQuery, viewMode, demoParam } from "./router";
import { seedDemoData } from "./demo/seedDemo";
import { SearchPage } from "./search/SearchPage";
import { PlayerPage } from "./player/PlayerPage";
import { VideoInfoModal } from "./modals/VideoInfoModal";
import { FacesModal } from "./modals/FacesModal";
import { BlacklistModal } from "./modals/BlacklistModal";
import { ScenesModal } from "./modals/ScenesModal";
import { ScanningPage } from "./scanning/ScanningPage";
import { SettingsModal } from "./modals/SettingsModal";
import { ThumbnailPickerModal } from "./modals/ThumbnailPickerModal";
import { ensureRecentVideosList } from "./lists/lists";
import { EditListModal } from "./lists/EditListModal";
import { ReorderListsModal } from "./lists/ReorderListsModal";
import { FaceTest } from "./faces/FaceTest";
import { page } from "./router";
import { heygoogleEnabled } from "./appState";
import { HeyGooglePage } from "./heygoogle/HeyGooglePage";
import { NotificationModal } from "./heygoogle/NotificationModal";
import { ToastStack } from "./heygoogle/Toasts";
import { ensureConnected, updateCapabilities } from "./heygoogle/client";
import { CAPABILITIES } from "./heygoogle/deviceProtocol";
import { BUILD_TIMESTAMP } from "../buildVersion";
import { getCompactingDatabases } from "./compactionStatus";
import { ThemeStyle } from "./restyle/ThemeStyle";
import { RestylingModal } from "./restyle/RestylingModal";
import { RS } from "./restyle/classNames";

const APP_NAME = "vidgrid";

// Build the document title from the URL params + per-video data.
// Returns a stable string so the mobx reaction only writes when it
// actually changed.
function deriveTitle(): string {
    if (page.value === "facetest") return `${APP_NAME} · facetest`;
    if (page.value === "heygoogle") return `${APP_NAME} · hey google`;
    const video = currentVideo.value;
    if (video) {
        const name = files.getSingleFieldSync(video, "name") ?? video;
        return `${APP_NAME} · ${name}`;
    }
    const parts: string[] = [APP_NAME, viewMode.value];
    const q = searchQuery.value.trim();
    if (q) parts.push(`"${q}"`);
    return parts.join(" · ");
}

function fmtBuildTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

@observer
class App extends preact.Component {
    private titleReaction: IReactionDisposer | undefined;

    componentDidMount() {
        // Demo mode seeds a synthetic library and skips the real folder
        // acquisition + cross-tab scan lock entirely.
        if (demoParam.value) {
            void seedDemoData();
        } else {
            // Just acquire the handle — scanning now runs entirely in the single
            // background SharedWorker, not in any tab.
            void ensureFolder();
            // Make sure the built-in "most recent videos" list exists.
            void ensureRecentVideosList();
            // Connect this tab to the ONE background scan worker and hand it the
            // directory handle. Replaces the old per-tab foreground scan schedule.
            startScanClient();
        }
        // Keep document.title in sync with the current page + URL state.
        // deriveTitle reads observables; reaction re-runs on any change.
        this.titleReaction = reaction(
            () => deriveTitle(),
            title => { document.title = title; },
            { fireImmediately: true },
        );
        // When the user has opted into hey-google mode, keep the device socket
        // up on every page so voice-driven device-calls reach the player and
        // notifications can pop regardless of where the user is in the app.
        if (heygoogleEnabled.get()) {
            void ensureConnected()
                // If this browser is a registered device, refresh its advertised
                // capabilities so command/schema changes reach the LLM without
                // re-pairing. No-ops (throws, ignored) for non-device accounts.
                .then(() => updateCapabilities(CAPABILITIES).catch(() => { }))
                .catch(console.error);
        }
    }

    componentWillUnmount() {
        if (this.titleReaction) this.titleReaction();
    }

    render() {
        const currentPage = page.value;
        const onPlayer = !!currentVideo.value;
        const compacting = getCompactingDatabases();
        return <div className={css.relative.minHeight("100vh").hsl(0, 0, 7) + RS.Page
            + (disableThemeBackgrounds.get() ? " no-bg" : "")}>
            <ThemeStyle />
            {!onPlayer && <div className={css.fixed.bottom(0).right(0).hbox(8).alignCenter.zIndex(1000)
                .pointerEvents("none")}>
                {compacting.length > 0 && <div
                    title={`Compacting:\n${compacting.join("\n")}`}
                    className={css.fontSize(11).pad2(5, 3).pointerEvents("auto").cursor("default")
                        .hsla(0, 0, 0, 0.4).color("hsl(0, 0%, 70%)") + RS.CompactingChip}
                >
                    compacting: {compacting.length}
                </div>}
                {/* Scanning chip sits flush against the build chip (no gap). */}
                <div className={css.hbox(0).alignCenter}>
                <VictimScanChip />
                <div
                    title={BUILD_TIMESTAMP}
                    className={css.fontSize(11).pad2(5, 3).pointerEvents("none")
                        .hsla(0, 0, 0, 0.4).color("hsl(0, 0%, 70%)") + RS.BuildChip}
                >
                    build: {fmtBuildTime(BUILD_TIMESTAMP)}
                </div>
                </div>
            </div>}
            {currentPage === "facetest"
                ? <FaceTest />
                : currentPage === "heygoogle"
                    ? <HeyGooglePage />
                    : currentPage === "scanning"
                        ? <ScanningPage />
                        : (onPlayer ? <PlayerPage /> : <SearchPage />)}
            <VideoInfoModal />
            <FacesModal />
            <BlacklistModal />
            <ScenesModal />
            <SettingsModal />
            <ThumbnailPickerModal />
            <EditListModal />
            <ReorderListsModal />
            <NotificationModal />
            <RestylingModal />
            <ToastStack />
        </div>;
    }
}

async function main() {
    if (isNode()) return;
    configureMobxNextFrameScheduler();
    preact.render(<App />, document.getElementById("app")!);
}

main().catch(console.error);
