// STYLE: no rounded corners anywhere in this project — never call .borderRadius
// on any element. Keep edges sharp.

import * as preact from "preact";
import { reaction, IReactionDisposer } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css, isNode } from "typesafecss";
import { configureMobxNextFrameScheduler } from "sliftutils/render-utils/mobxTyped";
import { ensureFolder, startLockPolling, files, disableThemeBackgrounds } from "./appState";
import { currentVideo, searchQuery, viewMode, demoParam } from "./router";
import { seedDemoData } from "./demo/seedDemo";
import { SearchPage } from "./search/SearchPage";
import { PlayerPage } from "./player/PlayerPage";
import { VideoInfoModal } from "./modals/VideoInfoModal";
import { SettingsModal } from "./modals/SettingsModal";
import { ThumbnailPickerModal } from "./modals/ThumbnailPickerModal";
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
            // Just acquire the handle — the scan is kicked off from SearchPage so
            // the player page doesn't churn on remount.
            void ensureFolder();
            // Watch the cross-tab scan lock so both pages can show "another tab
            // is scanning" without each of them having to try to acquire it.
            startLockPolling();
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
        return <div className={css.relative.minHeight("100vh").hsl(0, 0, 7) + RS.Page
            + (disableThemeBackgrounds.get() ? " no-bg" : "")}>
            <ThemeStyle />
            {!onPlayer && <div
                title={BUILD_TIMESTAMP}
                className={css.fixed.bottom(0).right(0).fontSize(11).pad2(5, 3).zIndex(1000)
                    .pointerEvents("none").hsla(0, 0, 0, 0.4).color("hsl(0, 0%, 70%)") + RS.BuildChip}
            >
                build: {fmtBuildTime(BUILD_TIMESTAMP)}
            </div>}
            {currentPage === "facetest"
                ? <FaceTest />
                : currentPage === "heygoogle"
                    ? <HeyGooglePage />
                    : (onPlayer ? <PlayerPage /> : <SearchPage />)}
            <VideoInfoModal />
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
