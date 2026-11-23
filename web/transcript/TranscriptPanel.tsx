import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { Input } from "sliftutils/render-utils/Input";
import { formatTime } from "socket-function/src/formatting/format";
import { transcripts } from "../appState";
import { fieldInput, buttonDown } from "../styles";
import { RS } from "../restyle/classNames";
import { decodeTranscript, groupTranscriptLines, TranscriptLine } from "./transcriptFormat";

const TIMESTAMP_COLUMN_WIDTH = 64;
const MUTED_COLOR = "hsl(0, 0%, 60%)";
const ERROR_COLOR = "hsl(0, 70%, 70%)";
const TIMESTAMP_COLOR = "hsl(210, 70%, 72%)";

const transcriptFilter = observable.box("");
const linesByBytes = new WeakMap<Uint8Array, TranscriptLine[]>();

export function resetTranscriptFilter(): void {
    runInAction(() => transcriptFilter.set(""));
}

function linesFor(bytes: Uint8Array): TranscriptLine[] | undefined {
    let cached = linesByBytes.get(bytes);
    if (cached) return cached;
    let decoded = decodeTranscript(bytes);
    if (!decoded) return undefined;
    let lines = groupTranscriptLines(decoded);
    linesByBytes.set(bytes, lines);
    return lines;
}

function clock(ms: number): string {
    let total = Math.max(0, Math.floor(ms / 1000));
    let h = Math.floor(total / 3600);
    let m = Math.floor((total % 3600) / 60);
    let s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
}

@observer
export class TranscriptPanel extends preact.Component<{
    fileKey: string;
    onSeek: (seconds: number) => void;
}> {
    render() {
        let key = this.props.fileKey;
        let version = transcripts.getSingleFieldSync(key, "transcriptVersion");
        let muted = css.fontSize(13).color(MUTED_COLOR) + RS.Muted;
        if (version === undefined) {
            return <div className={muted}>
                No transcript for this file yet. Transcripts are made by the offline parse (yarn parse) while fastvoice is running.
            </div>;
        }
        let error = transcripts.getSingleFieldSync(key, "transcriptError");
        if (error) {
            return <div className={css.fontSize(12).color(ERROR_COLOR).whiteSpace("pre-wrap").overflowWrap("break-word")}>
                Transcription failed: {error}
            </div>;
        }
        if (transcripts.getSingleFieldSync(key, "transcriptNoAudio")) {
            return <div className={muted}>This file has no audio track, so there is nothing to transcribe.</div>;
        }
        let bytes = transcripts.getSingleFieldSync(key, "transcript");
        let lines = bytes && linesFor(bytes);
        if (!lines) {
            return <div className={muted}>Loading transcript...</div>;
        }
        let wordCount = transcripts.getSingleFieldSync(key, "transcriptWordCount") ?? 0;
        let extractedAt = transcripts.getSingleFieldSync(key, "transcriptExtractedAt");
        let extractionMs = transcripts.getSingleFieldSync(key, "transcriptExtractionMs");
        let model = transcripts.getSingleFieldSync(key, "transcriptModel");
        let summary = [
            `${wordCount.toLocaleString()} words`,
            `${lines.length.toLocaleString()} lines`,
            extractedAt ? `transcribed ${new Date(extractedAt).toLocaleString()}` : "",
            extractionMs !== undefined ? `took ${formatTime(extractionMs)}` : "",
            model ?? "",
        ].filter(part => part).join(" · ");
        if (lines.length === 0) {
            return <div className={css.vbox(8).fillWidth}>
                <div className={muted}>No speech was recognised in this file.</div>
                <div className={css.fontSize(11).color(MUTED_COLOR) + RS.Muted}>{summary}</div>
            </div>;
        }
        let filter = transcriptFilter.get().trim().toLowerCase();
        let shown = filter ? lines.filter(line => line.text.toLowerCase().includes(filter)) : lines;
        return <div className={css.vbox(8).fillWidth}>
            <div className={css.fontSize(11).color(MUTED_COLOR) + RS.Muted}>{summary}</div>
            <Input
                hot
                placeholder="Search this transcript"
                value={transcriptFilter.get()}
                onChangeValue={value => runInAction(() => transcriptFilter.set(value))}
                className={fieldInput}
            />
            {filter && <div className={css.fontSize(11).color(MUTED_COLOR) + RS.Muted}>
                {shown.length.toLocaleString()} of {lines.length.toLocaleString()} lines match
            </div>}
            <div className={css.vbox(2).fillWidth}>
                {shown.map(line => <div
                    key={line.startMs}
                    className={css.hbox(10).alignItems("flex-start").fillWidth.pad2(4, 2).pointer}
                    title={`Play from ${clock(line.startMs)}`}
                    onMouseDown={buttonDown(() => this.props.onSeek(line.startMs / 1000))}
                >
                    <div className={css.width(TIMESTAMP_COLUMN_WIDTH).flexShrink(0).fontSize(12).color(TIMESTAMP_COLOR)
                        .fontFamily("monospace")}>
                        {clock(line.startMs)}
                    </div>
                    <div className={css.fontSize(13).flexGrow(1).minWidth(0).overflowWrap("break-word")}>
                        {line.text}
                    </div>
                </div>)}
            </div>
        </div>;
    }
}
