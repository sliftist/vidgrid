// Blacklisted faces manager — a sub-modal (opened from the faces modal) that
// lists every face the user has flagged as bad and lets them un-blacklist any
// of them. Blacklisted faces are pulled out of the normal character list in the
// faces modal; removing one here brings its matching characters back.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { modalCloseBtn, buttonDown } from "../styles";
import { RS } from "../restyle/classNames";
import { FaceAvatar } from "../faces/FaceAvatar";
import { getBlacklistedFacesSync, blacklistLoadedSync, unblacklistFace } from "../faces/faceBlacklist";
import { files } from "../appState";
import { playSound } from "../sounds";

const blacklistOpen = observable.box<boolean>(false);

export function openBlacklistModal() {
    playSound("modalOpen");
    runInAction(() => blacklistOpen.set(true));
}

export function closeBlacklistModal() {
    playSound("modalClose");
    runInAction(() => blacklistOpen.set(false));
}

@observer
export class BlacklistModal extends preact.Component {
    componentDidMount() { document.addEventListener("keydown", this.onKeyDown); }
    componentWillUnmount() { document.removeEventListener("keydown", this.onKeyDown); }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && blacklistOpen.get()) {
            e.preventDefault();
            e.stopPropagation();
            closeBlacklistModal();
        }
    };

    render() {
        if (!blacklistOpen.get()) return null;
        const loaded = blacklistLoadedSync();
        const list = getBlacklistedFacesSync();

        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) { e.preventDefault(); closeBlacklistModal(); } }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2100)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white")
                    .maxWidth(820).fillWidth.maxHeight("85vh").overflowHidden
                    .bord(1, "hsl(0, 0%, 22%)").vbox(0) + RS.Modal}
            >
                <div className={css.pad2(16, 22).hbox(12).alignItems("center").fillWidth.flexShrink(0)
                    .borderBottom("1px solid hsl(0, 0%, 18%)")}>
                    <div className={css.fontSize(15).flexGrow(1).minWidth(0) + RS.ModalTitle}>
                        Blacklisted faces{list.length > 0 ? ` (${list.length})` : ""}
                    </div>
                    <button
                        onMouseDown={buttonDown(() => closeBlacklistModal())}
                        className={modalCloseBtn + css.flexShrink(0)}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>
                <div className={css.pad2(14, 22).flexGrow(1).minHeight(0).overflowY("auto").overflowX("hidden").vbox(12).fillWidth}>
                    <div className={css.fontSize(12).color("hsl(0, 0%, 60%)") + RS.Muted}>
                        Flagged bad faces are hidden from the normal character list. Any detected character within the same-person distance of one of these is moved to the blacklisted section instead. Un-blacklist to bring it back.
                    </div>
                    {list.length === 0 ? (
                        <div className={css.fontSize(13).color("hsl(0, 0%, 60%)") + RS.Muted}>
                            {loaded ? "Nothing is blacklisted." : "Loading..."}
                        </div>
                    ) : (
                        <div className={css.hbox(10, 10).wrap.alignItems("flex-start")}>
                            {list.map(b => {
                                const srcName = b.fileKey ? files.getSingleFieldSync(b.fileKey, "name") : undefined;
                                return <div key={b.key} className={css.vbox(6).width(140).alignItems("center")
                                    .pad2(8, 8).hsl(0, 0, 12).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
                                    <FaceAvatar jpeg={b.avatarJpeg} size={112} title={srcName ?? b.key} />
                                    <div className={css.fontSize(10).color("hsl(0, 0%, 62%)").maxWidth(124).ellipsis + RS.Muted}
                                        title={srcName ?? b.key}>
                                        {srcName ?? b.key}
                                    </div>
                                    <button
                                        onMouseDown={buttonDown(() => { playSound("toggle"); void unblacklistFace(b.key); })}
                                        className={css.fontSize(11).pad2(10, 5).pointer.hsl(0, 0, 16)
                                            .color("hsl(0, 0%, 82%)").bord(1, "hsl(0, 0%, 30%)").hslhover(0, 0, 22) + RS.Button}
                                        title="Remove this face from the blacklist"
                                    >
                                        Un-blacklist
                                    </button>
                                </div>;
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>;
    }
}
