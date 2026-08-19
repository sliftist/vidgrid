// The subtitle picker: every source the video offers, in one list.
//
// Auto-selection can only ever be a guess -- a rip may carry four Nordic
// languages and no English, or a sidecar that's better than anything muxed in.
// So the menu shows everything found, says where each came from, and lets the
// viewer both switch for this video and change the preference that drives the
// automatic pick next time.

import * as preact from "preact";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { RS } from "../restyle/classNames";
import { actionBtn, buttonDown, chipBtn, chipPrimary } from "../styles";
import { languageName, matchesLanguage, SubtitleSource } from "./subtitleSources";
import { genState } from "../subtitleGen/generator";

type Props = {
    sources: SubtitleSource[];
    selectedId: string | undefined;
    loadingId: string | undefined;
    // Language preference driving the automatic pick, and its setter.
    preferredLanguage: string;
    onPreferLanguage: (lang: string) => void;
    onSelect: (source: SubtitleSource) => void;
    onOff: () => void;
    subtitlesOn: boolean;
    onClose: () => void;
    // Speech-to-text generation for this video.
    videoKey: string | undefined;
    onGenerate: () => void;
    onStopGenerate: () => void;
};

const rowBase = css.hbox(8).alignCenter.fillWidth.pad2(8, 5).fontSize(11)
    .textAlign("left").border("none").pointer;

function fmtSec(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
}

@observer
export class SubtitleMenu extends preact.Component<Props> {
    // Generation runs ahead of the playhead, so the useful readout is not a
    // percentage but the LEAD: how many seconds of transcript exist past where
    // you are watching. A lead that keeps shrinking means the machine cannot
    // keep up, which is the thing worth showing.
    private renderGenerate() {
        const { videoKey } = this.props;
        const mine = genState.key === videoKey && videoKey !== undefined;
        const phase = mine ? genState.phase : "idle";
        const running = phase === "loading" || phase === "running";
        const lead = genState.processedToSec - genState.playheadSec;

        return <div className={css.vbox(4).pad2(8, 8).borderTop("1px solid hsl(0, 0%, 20%)")}>
            <div className={css.fontSize(10).color("hsl(0, 0%, 60%)")}>
                Create subtitles from the audio
            </div>
            <div className={css.hbox(8).alignCenter}>
                <button
                    onMouseDown={buttonDown(() => {
                        if (running) this.props.onStopGenerate();
                        else this.props.onGenerate();
                    })}
                    disabled={!videoKey}
                    className={actionBtn + css.fontSize(11)}
                    title={running
                        ? "Stop transcribing"
                        : "Transcribe this video's speech, translating into your preferred language"}
                >
                    {running ? "Stop" : phase === "done" ? "Generate again" : "Generate"}
                </button>
                {mine && phase === "running" && <div className={css.fontSize(10).color("hsl(0, 0%, 65%)")}>
                    {genState.cues.length} cues · {lead >= 0 ? `${fmtSec(lead)} ahead` : "behind"}
                    {genState.translating ? " · translating" : ""}
                </div>}
                {mine && phase === "loading" && <div className={css.fontSize(10).color("hsl(45, 80%, 65%)")}>
                    {genState.message}
                </div>}
                {mine && phase === "done" && <div className={css.fontSize(10).color("hsl(120, 40%, 65%)")}>
                    {genState.cues.length} cues
                </div>}
            </div>
            {mine && phase === "running" && <div className={css.fontSize(10).color("hsl(0, 0%, 50%)")}>
                transcribed to {fmtSec(genState.processedToSec)} · playing {fmtSec(genState.playheadSec)}
            </div>}
            {mine && phase === "error" && <div className={css.fontSize(10).color("hsl(0, 70%, 68%)")}>
                {genState.error}
            </div>}
        </div>;
    }

    render() {
        const { sources, selectedId, loadingId, preferredLanguage, subtitlesOn } = this.props;

        // One chip per distinct language present, so setting the preference is a
        // click rather than typing a code the viewer has to already know. The
        // languages in this file are exactly the ones worth offering.
        const langs: { code: string; name: string }[] = [];
        for (const s of sources) {
            const code = s.lang.trim().toLowerCase();
            if (!code || langs.some(l => l.code === code)) continue;
            langs.push({ code, name: languageName(code) });
        }

        return <div
            onMouseDown={e => e.stopPropagation()}
            className={css.absolute.bottom("100%").left(0).marginBottom(6)
                .vbox(0).minWidth(280).maxWidth(420).maxHeight(360).overflowAuto
                .hsl(0, 0, 8).color("white").bord(1, "hsl(0, 0%, 22%)")
                .zIndex(60).boxShadow("0 6px 24px hsla(0, 0%, 0%, 0.6)") + RS.PlayerPill}
        >
            <div className={css.pad2(8, 6).fontSize(10).fontWeight(600)
                .color("hsl(0, 0%, 60%)").textTransform("uppercase").letterSpacing(0.5)}>
                Subtitles
            </div>

            <button
                onMouseDown={buttonDown(() => { this.props.onOff(); this.props.onClose(); })}
                className={rowBase + (!subtitlesOn ? css.hsl(210, 60, 26) : css.background("transparent"))
                    + css.color("white") + RS.Button}
            >
                <span className={css.width(14).flexShrink0}>{!subtitlesOn ? "✓" : ""}</span>
                <span>Off</span>
            </button>

            {sources.length === 0 && <div className={css.pad2(8, 8).fontSize(11).color("hsl(0, 0%, 60%)")}>
                No subtitles found for this video.
            </div>}

            {sources.map(s => {
                const active = subtitlesOn && s.id === selectedId;
                return <button
                    key={s.id}
                    disabled={!s.supported}
                    onMouseDown={buttonDown(() => { if (s.supported) this.props.onSelect(s); })}
                    className={rowBase
                        + (active ? css.hsl(210, 60, 26) : css.background("transparent"))
                        + css.color(s.supported ? "white" : "hsl(0, 0%, 45%)")
                        + (s.supported ? css.pointer : css.cursor("default"))
                        + RS.Button}
                    title={s.detail || undefined}
                >
                    <span className={css.width(14).flexShrink0}>{active ? "✓" : ""}</span>
                    <span className={css.vbox(1).minWidth(0).flexGrow(1)}>
                        <span className={css.hbox(6).alignCenter}>
                            <span>{s.langName}</span>
                            {matchesLanguage(s, preferredLanguage) && <span
                                className={css.fontSize(9).color("hsl(210, 70%, 70%)")}
                                title="Matches your preferred language"
                            >preferred</span>}
                        </span>
                        {s.detail && <span className={css.fontSize(10).color("hsl(0, 0%, 55%)")
                            .whiteSpace("nowrap").overflowHidden.textOverflow("ellipsis")}>
                            {s.detail}
                        </span>}
                    </span>
                    <span className={css.fontSize(10).color("hsl(0, 0%, 60%)").flexShrink0}>
                        {s.origin === "sidecar" ? "file" : "embedded"} · {s.format}
                    </span>
                    {loadingId === s.id && <span className={css.fontSize(10).color("hsl(45, 80%, 65%)")}>...</span>}
                    {!s.supported && <span className={css.fontSize(10).color("hsl(0, 0%, 45%)")}>unsupported</span>}
                </button>;
            })}

            {this.renderGenerate()}

            {langs.length > 0 && <div className={css.vbox(4).pad2(8, 8)
                .borderTop("1px solid hsl(0, 0%, 20%)")}>
                <div className={css.fontSize(10).color("hsl(0, 0%, 60%)")}>
                    Prefer this language on every video
                </div>
                <div className={css.hbox(4, 3).flexWrap("wrap")}>
                    {langs.map(l => <button
                        key={l.code}
                        onMouseDown={buttonDown(() => this.props.onPreferLanguage(l.code))}
                        className={preferredLanguage.trim().toLowerCase() === l.code ? chipPrimary : chipBtn}
                        title={`Default to ${l.name} when this video's subtitles are picked automatically`}
                    >
                        {l.name}
                    </button>)}
                </div>
            </div>}

            <div className={css.hbox(6).justifyContent("flex-end").pad2(8, 6)
                .borderTop("1px solid hsl(0, 0%, 20%)")}>
                <button
                    onMouseDown={buttonDown(() => this.props.onClose())}
                    className={actionBtn + css.fontSize(11)}
                >
                    Close
                </button>
            </div>
        </div>;
    }
}
