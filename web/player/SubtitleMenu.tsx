// The subtitle picker: every source the video offers, in one list.
//
// Auto-selection can only ever be a guess -- a rip may carry four Nordic
// languages and no English, or a sidecar that's better than anything muxed in.
// So the menu shows everything found, says where each came from, and lets the
// viewer both switch for this video and change the preference that drives the
// automatic pick next time.
//
// It is a PANEL, not a dropdown. Once it started carrying a transcript beside
// its translation -- two columns of text you actually read and compare -- a
// 280px flyout hanging off the CC button was unusable. So it is centred and
// sized off the viewport instead of off the button it belongs to.

import * as preact from "preact";
import { css } from "typesafecss";
import { observer } from "sliftutils/render-utils/observer";
import { RS } from "../restyle/classNames";
import { actionBtn, buttonDown, chipBtn, chipDim, chipPrimary, progressFill, progressTrack } from "../styles";
import { languageEndonym, languageName, matchesLanguage, SubtitleSource, TRANSLATION_LANGUAGES } from "./subtitleSources";
import { formatEta, genCues, genState, pinGenerated, showGenerated } from "../subtitleGen/generator";
import { subtitleGenModel, setSubtitleGenModel } from "../appState";
import { LANGUAGE_MODELS } from "../subtitleGen/models";

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
    onGenerate: (mode: "stream" | "all", engine?: "whisper" | "parakeet") => void;
    onStopGenerate: () => void;
    // Translation of an already-generated transcript. Separate from generating
    // because it is a separate model over stored text -- see generator.ts.
    onTranslate: () => void;
    onStopTranslate: () => void;
    onDiscardGenerated: () => void;
    // What to translate INTO. "" means don't; there is no default, because a
    // guessed target is what made the model translate into nothing at all.
    translateLanguage: string;
    onTranslateLanguage: (lang: string) => void;
};

type State = { pickingLanguage: boolean };

const rowBase = css.hbox(8).alignCenter.fillWidth.pad2(8, 5).fontSize(11)
    .textAlign("left").border("none").pointer;

const sectionBox = css.vbox(6).fillWidth.pad2(10, 8)
    .borderTop("1px solid hsl(0, 0%, 20%)");

const sectionLabel = css.fontSize(10).color("hsl(0, 0%, 60%)");

const dimText = css.fontSize(10).color("hsl(0, 0%, 55%)");

function fmtSec(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
}

@observer
export class SubtitleMenu extends preact.Component<Props, State> {
    state: State = { pickingLanguage: false };

    // Generation runs ahead of the playhead, so the useful readout is not a
    // percentage but the LEAD: how many seconds of transcript exist past where
    // you are watching. A lead that keeps shrinking means the machine cannot
    // keep up, which is the thing worth showing. "Generate all" has no playhead
    // to lead, so there the useful number is the ETA.
    private renderGenerate() {
        const { videoKey } = this.props;
        const mine = genState.key === videoKey && videoKey !== undefined;
        const phase = mine ? genState.phase : "idle";
        const running = phase === "loading" || phase === "running";
        const lead = genState.processedToSec - genState.playheadSec;
        const all = genState.mode === "all";

        return <div className={sectionBox}>
            <div className={sectionLabel}>Create subtitles from the audio</div>
            <div className={css.hbox(8).alignCenter.flexWrap("wrap")}>
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
                        {/* This run only; does not change the setting. */}
                        <button
                            onMouseDown={buttonDown(() => this.props.onGenerate("all", "parakeet"))}
                            disabled={!videoKey}
                            className={actionBtn + css.fontSize(11)}
                            title="Transcribe the whole file with Parakeet instead of Whisper: faster, but it only knows 25 European languages and cannot be told which one it is hearing."
                        >
                            Generate with Parakeet
                        </button>
                    </preact.Fragment>}
                {mine && phase === "running" && <div className={css.fontSize(10).color("hsl(0, 0%, 65%)")}>
                    {genState.transcript.length} cues · {all
                        ? `${fmtSec(genState.processedToSec)}${genState.durationSec ? ` / ${fmtSec(genState.durationSec)}` : ""}`
                        : lead >= 0 ? `${fmtSec(lead)} ahead` : "behind"}
                    {genState.etaSec !== undefined ? ` · ${formatEta(genState.etaSec)} left` : ""}
                </div>}
                {mine && (phase === "loading" || phase === "running") && genState.message
                    && <div className={css.fontSize(10).color("hsl(45, 80%, 65%)").minWidth(0)}>
                        {genState.message}
                    </div>}
                {mine && phase === "done" && <div className={css.fontSize(10).color("hsl(120, 40%, 65%)")}>
                    {genState.transcript.length} cues
                </div>}
            </div>
            {/* The first run downloads a ~456 MB speech model. On a slow link
              * that is minutes of nothing happening, so the bar is not decoration
              * -- without it the feature looks hung. */}
            {/* The current phase's own fraction when it has one; otherwise, in
              * "all" mode, how much of the file has been heard. */}
            {mine && (phase === "loading" || phase === "running")
                && genState.progress !== undefined
                && <div className={progressTrack}>
                    <div className={progressFill}
                        style={{ width: `${Math.round(genState.progress * 100)}%` }} />
                </div>}
            {mine && all && phase === "running" && genState.progress === undefined
                && genState.durationSec > 0
                && <div className={progressTrack}>
                    <div className={progressFill} style={{
                        width: `${Math.round(Math.min(1, genState.processedToSec / genState.durationSec) * 100)}%`,
                    }} />
                </div>}
            {mine && (phase === "running" || phase === "done") && <div className={dimText}>
                heard to {fmtSec(genState.processedToSec)}
                {all ? "" : ` · playing ${fmtSec(genState.playheadSec)}`}
            </div>}
            {mine && phase === "error" && <div className={css.fontSize(10).color("hsl(0, 70%, 68%)")}>
                {genState.error}
            </div>}
        </div>;
    }

    // Which language to translate into. Its own setting, and its own control:
    // it is NOT the "prefer this track" preference below, which answers a
    // different question. Empty is a legitimate value -- it means "don't".
    private renderLanguagePicker() {
        const { translateLanguage } = this.props;
        const chosen = translateLanguage.trim().toLowerCase();
        if (!this.state.pickingLanguage) {
            return <div className={css.hbox(6).alignCenter.flexWrap("wrap")}>
                <span className={sectionLabel}>Translate into</span>
                <span className={chosen ? chipPrimary : chipDim}>
                    {chosen ? `${languageEndonym(chosen)} (${languageName(chosen)})` : "not set"}
                </span>
                <button
                    onMouseDown={buttonDown(() => this.setState({ pickingLanguage: true }))}
                    className={chipBtn}
                >
                    Change
                </button>
            </div>;
        }
        return <div className={css.vbox(4).fillWidth}>
            <div className={sectionLabel}>Translate into</div>
            {/* Each language is named in ITSELF, which is also exactly what the
              * model gets told -- see Translator.systemPrompt(). */}
            <div className={css.hbox(4, 2).flexWrap("wrap").fillWidth}>
                <button
                    onMouseDown={buttonDown(() => {
                        this.props.onTranslateLanguage("");
                        this.setState({ pickingLanguage: false });
                    })}
                    className={!chosen ? chipPrimary : chipBtn}
                    title="Leave generated subtitles in the language they were spoken in"
                >
                    Don't translate
                </button>
                {TRANSLATION_LANGUAGES.map(l => <button
                    key={l.code}
                    onMouseDown={buttonDown(() => {
                        this.props.onTranslateLanguage(l.code);
                        this.setState({ pickingLanguage: false });
                    })}
                    className={chosen === l.code ? chipPrimary : chipBtn}
                    title={l.name}
                >
                    {l.endonym}
                </button>)}
            </div>
        </div>;
    }

    private renderModelChips() {
        const cur = subtitleGenModel.get();
        return LANGUAGE_MODELS.map(m => {
            const selected = cur === m.key;
            const sizeLabel = m.downloadMb >= 1024
                ? `${(m.downloadMb / 1024).toFixed(m.downloadMb >= 10240 ? 1 : 1)} GB`
                : `${m.downloadMb} MB`;
            return <button
                key={m.key}
                onMouseDown={buttonDown(() => setSubtitleGenModel(m.key))}
                title={m.detail}
                className={selected ? chipPrimary : chipBtn}
            >
                {m.label} ({sizeLabel})
            </button>;
        });
    }

    // Translation is its own step over the stored transcript, so it gets its
    // own controls. Both texts are kept, which is what makes "translate again,
    // into something else" cost one LLM pass instead of a second trip through
    // the speech model.
    private renderTranslate() {
        if (!genState.transcript.length) return null;
        const chosen = this.props.translateLanguage.trim().toLowerCase();
        const targetName = chosen ? languageEndonym(chosen) : "";
        const haveTranslation = genState.translation.length > 0;
        const busy = genState.translating;
        const canTranslate = !!chosen && genState.complete && !busy;

        return <div className={sectionBox}>
            {this.renderLanguagePicker()}
            <div className={css.hbox(8).alignCenter.flexWrap("wrap")}>
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
                        title={!chosen
                            ? "Pick a language to translate into first."
                            : !genState.complete
                                ? "Only a transcript covering the whole file can be translated. Use \"Generate all\" first."
                                : `Translate all ${genState.transcript.length} lines into ${targetName}. The transcript is kept, so this can be redone into another language without transcribing again.`}
                    >
                        {!chosen ? "Translate all"
                            : haveTranslation ? `Translate all again into ${targetName}`
                                : `Translate all ${genState.transcript.length} lines into ${targetName}`}
                    </button>}
                {!busy && this.renderModelChips()}
                {busy && <span className={css.fontSize(10).color("hsl(45, 80%, 65%)").minWidth(0)}>
                    {genState.translateProgress !== undefined
                        ? `${Math.round(genState.translateProgress * 100)}% · ${genState.translation.length}/${genState.transcript.length}`
                            + (genState.translateEtaSec !== undefined ? ` · ${formatEta(genState.translateEtaSec)} left` : "")
                        : genState.message}
                </span>}
                {!busy && !genState.complete && <span className={dimText}>
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
            {/* Which text the PLAYER shows. Both stay visible in the list
              * below either way: the translation is a second model's guess at
              * the first model's guess, and seeing them side by side is how
              * you tell which one is wrong. */}
            {haveTranslation && <div className={css.hbox(6).alignCenter.flexWrap("wrap")}>
                <span className={sectionLabel}>On screen</span>
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
                    {languageEndonym(genState.translatedLanguage || "")}
                </button>
            </div>}
        </div>;
    }

    // The generated text, original beside translation. This is the only place
    // the two can be compared, and comparing them is the only way to tell the
    // halves apart: nothing in the left column means the speech model heard
    // nothing, whereas text on the left and nonsense on the right means the
    // translation model is the broken half.
    private renderTranscript() {
        const original = genState.transcript;
        const translated = genState.translation;
        if (!original.length && genState.phase !== "running") return null;
        const twoUp = translated.length > 0;
        const shownName = languageEndonym(genState.translatedLanguage || "");

        return <div className={sectionBox + css.minHeight(0).flexGrow(1)}>
            <div className={css.hbox(6).alignCenter.flexWrap("wrap")}>
                <span className={sectionLabel}>Transcript ({original.length})</span>
                {original.length > 0 && <button
                    onMouseDown={buttonDown(() => {
                        const lines = genCues();
                        void navigator.clipboard?.writeText(
                            lines.map(c => `${fmtSec(c.startMs / 1000)}  ${c.text}`).join("\n"));
                    })}
                    className={chipBtn}
                    title="Copy the text currently shown on screen, with timestamps"
                >
                    Copy
                </button>}
                {/* A restored transcript does not shove aside a track the file
                  * actually ships with -- it waits to be asked for. */}
                {original.length > 0 && !genState.pinned && <button
                    onMouseDown={buttonDown(() => { pinGenerated(); this.props.onClose(); })}
                    className={chipBtn}
                    title="Show these lines instead of the selected subtitle track"
                >
                    Use these
                </button>}
                {original.length > 0 && genState.phase !== "running" && genState.phase !== "loading"
                    && <button
                        onMouseDown={buttonDown(() => this.props.onDiscardGenerated())}
                        className={chipBtn}
                        title="Delete the saved transcript and translation for this video"
                    >
                        Delete
                    </button>}
            </div>
            <div className={css.vbox(0).fillWidth.minHeight(120).flexGrow(1).overflowAuto
                .hsl(0, 0, 5).bord(1, "hsl(0, 0%, 18%)")}>
                {original.length === 0 && <span className={dimText.pad2(8, 6)}>
                    Nothing heard yet.
                </span>}
                {twoUp && <div className={css.display("grid").fillWidth
                    .gridTemplateColumns("54px 1fr 1fr").position("sticky").top(0)
                    .hsl(0, 0, 9).zIndex(1).borderBottom("1px solid hsl(0, 0%, 18%)")}>
                    <span className={dimText.pad2(6, 4)}>Time</span>
                    <span className={dimText.pad2(6, 4)}>Original</span>
                    <span className={dimText.pad2(6, 4)}>{shownName}</span>
                </div>}
                {/* Newest last, and the box is scrolled by hand -- auto-scroll
                  * would fight anyone reading back through it. */}
                <div className={css.display("grid").fillWidth
                    .gridTemplateColumns(twoUp ? "54px 1fr 1fr" : "54px 1fr")}>
                    {original.map((c, i) => <preact.Fragment key={i}>
                        <span className={css.fontSize(10).color("hsl(0, 0%, 45%)")
                            .fontFamily("monospace").pad2(6, 3)}>
                            {fmtSec(c.startMs / 1000)}
                        </span>
                        <span className={css.fontSize(11).color("hsl(0, 0%, 82%)").minWidth(0)
                            .pad2(6, 3).overflowWrap("break-word")}>
                            {c.text}
                        </span>
                        {twoUp && <span className={css.fontSize(11).minWidth(0).pad2(6, 3)
                            .overflowWrap("break-word")
                            // Untranslated lines are left as the original by
                            // design (see Translator.translate) -- dimming the
                            // ones that came back unchanged is what makes that
                            // fallback visible instead of silently misleading.
                            .color(translated[i] && translated[i].text !== c.text
                                ? "hsl(150, 35%, 78%)" : "hsl(0, 0%, 42%)")}>
                            {translated[i]?.text ?? ""}
                        </span>}
                    </preact.Fragment>)}
                </div>
            </div>
        </div>;
    }

    render() {
        const { sources, selectedId, loadingId, preferredLanguage, subtitlesOn, videoKey } = this.props;
        const mine = genState.key === videoKey && videoKey !== undefined;

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
            // Fixed and centred rather than hung off the CC button: at this
            // size an absolutely-positioned flyout runs off whichever edge the
            // button happens to sit near.
            // width/maxHeight are inline: typesafecss types these as plain
            // lengths and rejects a CSS min() expression outright.
            style={{ width: "min(980px, 94vw)", maxHeight: "min(74vh, 780px)" }}
            className={css.fixed.left("50%").transform("translateX(-50%)").bottom(64)
                .vbox(0).overflowHidden
                .hsl(0, 0, 8).color("white").bord(1, "hsl(0, 0%, 22%)")
                .zIndex(60).boxShadow("0 8px 32px hsla(0, 0%, 0%, 0.7)") + RS.PlayerPill}
        >
            <div className={css.vbox(0).fillWidth.minHeight(0).flexGrow(1).overflowAuto}>
                <div className={css.pad2(10, 6).fontSize(10).fontWeight(600)
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

                {sources.length === 0 && <div className={css.pad2(10, 8).fontSize(11).color("hsl(0, 0%, 60%)")}>
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
                            {s.detail && <span className={dimText
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
                {mine && this.renderTranslate()}
                {mine && this.renderTranscript()}

                {langs.length > 0 && <div className={sectionBox}>
                    <div className={sectionLabel}>Prefer this language on every video</div>
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
            </div>

            <div className={css.hbox(6).justifyContent("flex-end").pad2(10, 6).flexShrink0
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
