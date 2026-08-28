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
import { actionBtn, buttonDown, chipBtn, chipPrimary, progressFill, progressTrack } from "../styles";
import { languageName, matchesLanguage, SubtitleSource } from "./subtitleSources";
import { genCues, genState, pinGenerated, showGenerated } from "../subtitleGen/generator";

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
    onGenerate: (mode: "stream" | "all") => void;
    onStopGenerate: () => void;
    // Translation of an already-generated transcript. Separate from generating
    // because it is a separate model over stored text -- see generator.ts.
    onTranslate: () => void;
    onStopTranslate: () => void;
    onDiscardGenerated: () => void;
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
        const all = genState.mode === "all";

        return <div className={css.vbox(4).pad2(8, 8).borderTop("1px solid hsl(0, 0%, 20%)")}>
            <div className={css.fontSize(10).color("hsl(0, 0%, 60%)")}>
                Create subtitles from the audio
            </div>
            <div className={css.hbox(8).alignCenter}>
                {running
                    ? <button
                        onMouseDown={buttonDown(() => this.props.onStopGenerate())}
                        className={actionBtn + css.fontSize(11)}
                        title="Stop transcribing"
                    >
                        Stop
                    </button>
                    : <preact.Fragment>
                        <button
                            onMouseDown={buttonDown(() => this.props.onGenerate("stream"))}
                            disabled={!videoKey}
                            className={actionBtn + css.fontSize(11)}
                            title="Transcribe from where you are, staying just ahead of the playhead"
                        >
                            {phase === "done" ? "Generate again" : "Generate"}
                        </button>
                        {/* Separate button rather than a mode toggle: the two
                          * differ in what they cost, not in what they produce,
                          * and a toggle hides that behind an extra click. */}
                        <button
                            onMouseDown={buttonDown(() => this.props.onGenerate("all"))}
                            disabled={!videoKey}
                            className={actionBtn + css.fontSize(11)}
                            title="Transcribe the whole file from the start, as fast as this machine manages. Ignores where you are watching."
                        >
                            Generate all
                        </button>
                    </preact.Fragment>}
                {mine && phase === "running" && <div className={css.fontSize(10).color("hsl(0, 0%, 65%)")}>
                    {genState.transcript.length} cues · {all
                        ? `${fmtSec(genState.processedToSec)}${genState.durationSec ? ` / ${fmtSec(genState.durationSec)}` : ""}`
                        : lead >= 0 ? `${fmtSec(lead)} ahead` : "behind"}
                </div>}
                {mine && phase === "loading" && <div className={css.fontSize(10).color("hsl(45, 80%, 65%)").minWidth(0)}>
                    {genState.message}
                </div>}
                {mine && phase === "done" && <div className={css.fontSize(10).color("hsl(120, 40%, 65%)")}>
                    {genState.transcript.length} cues
                </div>}
            </div>
            {/* The first run downloads a ~456 MB speech model. On a slow link
              * that is minutes of nothing happening, so the bar is not decoration
              * -- without it the feature looks hung. */}
            {mine && phase === "loading" && genState.progress !== undefined
                && <div className={progressTrack}>
                    <div className={progressFill}
                        style={{ width: `${Math.round(genState.progress * 100)}%` }} />
                </div>}
            {mine && (phase === "running" || phase === "done") && <div className={css.fontSize(10).color("hsl(0, 0%, 50%)")}>
                heard to {fmtSec(genState.processedToSec)}
                {all ? "" : ` · playing ${fmtSec(genState.playheadSec)}`}
            </div>}
            {mine && phase === "error" && <div className={css.fontSize(10).color("hsl(0, 70%, 68%)")}>
                {genState.error}
            </div>}
            {mine && this.renderTranslate()}
            {mine && this.renderTranscript()}
        </div>;
    }

    // Translation is its own step over the stored transcript, so it gets its
    // own controls. The two texts are both kept, which is what makes
    // "translate again, into something else" cost one LLM pass instead of a
    // second trip through the speech model.
    private renderTranslate() {
        const { targetLanguageName } = this;
        const haveTranscript = genState.transcript.length > 0;
        if (!haveTranscript) return null;
        const haveTranslation = genState.translation.length > 0;
        const busy = genState.translating;
        const canTranslate = genState.complete && !busy;

        return <div className={css.vbox(3).marginTop(4)}>
            <div className={css.hbox(6).alignCenter.flexWrap("wrap")}>
                {busy
                    ? <button
                        onMouseDown={buttonDown(() => this.props.onStopTranslate())}
                        className={actionBtn + css.fontSize(11)}
                        title="Stop translating"
                    >
                        Stop translating
                    </button>
                    : <button
                        onMouseDown={buttonDown(() => this.props.onTranslate())}
                        disabled={!canTranslate}
                        className={actionBtn + css.fontSize(11)}
                        title={genState.complete
                            ? `Translate the saved transcript into ${targetLanguageName}. The transcript is kept, so this can be redone into another language without transcribing again.`
                            : "Only a transcript that covers the whole file can be translated. Use \"Generate all\" first."}
                    >
                        {haveTranslation ? `Translate again to ${targetLanguageName}` : `Translate to ${targetLanguageName}`}
                    </button>}
                {busy && <span className={css.fontSize(10).color("hsl(45, 80%, 65%)").minWidth(0)}>
                    {genState.translateProgress !== undefined
                        ? `${Math.round(genState.translateProgress * 100)}% · ${genState.translation.length}/${genState.transcript.length}`
                        : genState.message}
                </span>}
                {!busy && !genState.complete
                    && <span className={css.fontSize(10).color("hsl(0, 0%, 50%)")}>
                        partial transcript ({fmtSec(genState.fromSec)}-{fmtSec(genState.processedToSec)})
                    </span>}
            </div>
            {/* Two different waits, one bar: the model download first (this
              * model is a 234-377 MB tarball), then the sweep through the
              * cues. Both are minutes long, and neither should look hung. */}
            {busy && (genState.translateProgress ?? genState.progress) !== undefined
                && <div className={progressTrack}>
                    <div className={progressFill} style={{
                        width: `${Math.round((genState.translateProgress ?? genState.progress ?? 0) * 100)}%`,
                    }} />
                </div>}
            {/* Both texts stay available: the translation is a second model's
              * guess at the first model's guess, so being able to flip back to
              * what was actually heard is how you tell which one is wrong. */}
            {haveTranslation && <div className={css.hbox(4, 2).flexWrap("wrap")}>
                <button
                    onMouseDown={buttonDown(() => showGenerated("transcript"))}
                    className={genState.showing === "transcript" ? chipPrimary : chipBtn}
                    title="Show the lines as the speech model heard them"
                >
                    Original
                </button>
                <button
                    onMouseDown={buttonDown(() => showGenerated("translation"))}
                    className={genState.showing === "translation" ? chipPrimary : chipBtn}
                    title="Show the translated lines"
                >
                    {languageName(genState.translatedLanguage || "")}
                </button>
            </div>}
        </div>;
    }

    private get targetLanguageName(): string {
        const code = this.props.preferredLanguage.trim().toLowerCase();
        return code ? languageName(code) : "English";
    }

    // The generated text itself, which is the only way to tell the two halves
    // apart: nothing here means the speech model heard nothing, whereas text
    // here but no cues on screen means translation is the broken half.
    private renderTranscript() {
        const lines = genCues();
        if (!lines.length && genState.phase !== "running") return null;
        const translated = genState.showing === "translation" && genState.translation.length > 0;

        return <div className={css.vbox(2).marginTop(4)}>
            <div className={css.hbox(6).alignCenter.flexWrap("wrap")}>
                <span className={css.fontSize(10).color("hsl(0, 0%, 60%)")}>
                    {translated ? "Translation" : "Transcript"} ({lines.length})
                </span>
                {lines.length > 0 && <button
                    onMouseDown={buttonDown(() => {
                        void navigator.clipboard?.writeText(
                            lines.map(c => `${fmtSec(c.startMs / 1000)}  ${c.text}`).join("\n"));
                    })}
                    className={chipBtn}
                    title="Copy the whole transcript"
                >
                    Copy
                </button>}
                {/* A restored transcript does not shove aside a track the file
                  * actually ships with -- it waits to be asked for. */}
                {lines.length > 0 && !genState.pinned && <button
                    onMouseDown={buttonDown(() => { pinGenerated(); this.props.onClose(); })}
                    className={chipBtn}
                    title="Show these lines instead of the selected subtitle track"
                >
                    Use these
                </button>}
                {lines.length > 0 && genState.phase !== "running" && genState.phase !== "loading"
                    && <button
                        onMouseDown={buttonDown(() => this.props.onDiscardGenerated())}
                        className={chipBtn}
                        title="Delete the saved transcript and translation for this video"
                    >
                        Delete
                    </button>}
            </div>
            <div className={css.vbox(2).fillWidth.maxHeight(140).overflowAuto
                .pad2(6, 4).hsl(0, 0, 5).bord(1, "hsl(0, 0%, 18%)")}>
                {lines.length === 0 && <span className={css.fontSize(10).color("hsl(0, 0%, 45%)")}>
                    Nothing heard yet.
                </span>}
                {/* Newest last, and the box is scrolled by hand -- auto-scroll
                  * would fight anyone reading back through it. */}
                {lines.map((c, i) => <div key={i} className={css.hbox(6).fontSize(10).fillWidth}>
                    <span className={css.color("hsl(0, 0%, 45%)").flexShrink0.fontFamily("monospace")}>
                        {fmtSec(c.startMs / 1000)}
                    </span>
                    <span className={css.color("hsl(0, 0%, 82%)").minWidth(0)}>{c.text}</span>
                </div>)}
            </div>
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
