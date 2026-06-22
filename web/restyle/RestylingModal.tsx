// The restyling manager. Lists every theme (built-in + custom), lets the user
// pick the active one, clone any theme, and edit/rename/delete custom clones.
// The editor is a raw-CSS textarea targeting the stable class names in
// classNames.ts; a reference panel lists every name + the naming convention so
// users know what they can target. Mirrors SettingsModal's modal shell.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { settingsPanelPad, actionBtn, chipBtn, primaryBtn, dangerBtn, selectorBtn, selectorBtnActive, fieldInput } from "../styles";
import { playSound } from "../sounds";
import { RS, RS_NAMES } from "./classNames";
import { modalParam } from "../router";
import {
    allThemes, getActiveThemeId, setActiveTheme, cloneTheme,
    updateThemeCss, renameTheme, deleteTheme,
} from "./themes";

// Which custom theme is open in the editor (built-ins aren't editable).
const editingId = observable.box<string | undefined>(undefined);

export function openRestyling() {
    playSound("modalOpen");
    modalParam.set("restyling");
}

export function closeRestyling() {
    playSound("modalClose");
    if (modalParam.get() === "restyling") modalParam.set("");
}

@observer
export class RestylingModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && modalParam.get() === "restyling") {
            e.preventDefault();
            closeRestyling();
        }
    };

    private clone = (id: string) => {
        const created = cloneTheme(id);
        if (created) {
            setActiveTheme(created.id);
            runInAction(() => editingId.set(created.id));
        }
    };

    private remove = (id: string, name: string) => {
        const typed = prompt(`Type the theme name to delete it:\n${name}`);
        if (typed === null) return;
        if (typed.trim() === name.trim()) {
            if (editingId.get() === id) runInAction(() => editingId.set(undefined));
            deleteTheme(id);
        }
    };

    render() {
        if (modalParam.get() !== "restyling") return null;
        const themes = allThemes();
        const activeId = getActiveThemeId();
        const editId = editingId.get();
        const editing = themes.find(t => t.id === editId && !t.builtIn);
        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) closeRestyling(); }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={settingsPanelPad + css.hsl(0, 0, 10).color("white")
                    .maxWidth(960).fillWidth.maxHeight("85vh").overflowAuto
                    .bord(1, "hsl(0, 0%, 22%)").vbox(12) + RS.Modal}
            >
                <div className={css.hbox(12).alignCenter}>
                    <div className={css.fontSize(15).flexGrow(1) + RS.ModalTitle}>Restyling</div>
                    <button onMouseDown={() => closeRestyling()} className={actionBtn} title="Close (Esc)">✕</button>
                </div>

                <div className={css.hbox(16).alignItems("stretch")}>
                    <div className={css.vbox(8).width(280).flexShrink(0)}>
                        <div className={css.fontSize(13).color("hsl(0, 0%, 75%)")}>Themes</div>
                        {themes.map(t => {
                            const isActive = t.id === activeId;
                            return <div key={t.id} className={css.vbox(6).pad(8)
                                .hsl(0, 0, isActive ? 16 : 13).bord(1, "hsl(0, 0%, 20%)") + RS.Surface}>
                                <div className={css.hbox(8).alignCenter}>
                                    <div className={css.flexGrow(1).fontSize(13)}>{t.name}</div>
                                    {t.builtIn && <div className={css.fontSize(10).color("hsl(0, 0%, 55%)")}>built-in</div>}
                                </div>
                                <div className={css.hbox(6).alignCenter.flexWrap("wrap")}>
                                    <button
                                        onMouseDown={() => setActiveTheme(t.id)}
                                        className={isActive ? selectorBtnActive : selectorBtn}
                                    >{isActive ? "Active" : "Use"}</button>
                                    <button onMouseDown={() => this.clone(t.id)} className={chipBtn}>Clone</button>
                                    {!t.builtIn && <button
                                        onMouseDown={() => runInAction(() => editingId.set(t.id))}
                                        className={t.id === editId ? selectorBtnActive : chipBtn}
                                    >Edit</button>}
                                    {!t.builtIn && <button
                                        onMouseDown={() => this.remove(t.id, t.name)}
                                        className={dangerBtn}
                                    >Delete</button>}
                                </div>
                            </div>;
                        })}
                    </div>

                    <div className={css.vbox(8).flexGrow(1).minWidth(0)}>
                        {editing
                            ? <>
                                <input
                                    className={fieldInput}
                                    value={editing.name}
                                    onInput={e => renameTheme(editing.id, (e.target as HTMLInputElement).value)}
                                />
                                <textarea
                                    spellcheck={false}
                                    value={editing.css}
                                    onInput={e => updateThemeCss(editing.id, (e.target as HTMLTextAreaElement).value)}
                                    className={fieldInput + css.minHeight(360).fontFamily("monospace")
                                        .fontSize(12).whiteSpace("pre").resize("vertical")}
                                />
                                <div className={css.fontSize(11).color("hsl(0, 0%, 55%)")}>
                                    Changes apply live. Target the class names on the right with plain CSS
                                    (e.g. <code>.Chip {"{ color: #f0f; }"}</code>).
                                </div>
                            </>
                            : <div className={css.fontSize(13).color("hsl(0, 0%, 60%)").pad(8)}>
                                Select a custom theme's <b>Edit</b> to change its CSS, or <b>Clone</b> a
                                theme to start a new one. Built-in themes can't be edited.
                            </div>}
                    </div>

                    <div className={css.vbox(6).width(240).flexShrink(0).overflowAuto.maxHeight("70vh")}>
                        <div className={css.fontSize(13).color("hsl(0, 0%, 75%)")}>Class reference</div>
                        <div className={css.fontSize(10).color("hsl(0, 0%, 55%)").vbox(2)}>
                            <div><code>Block</code> — a surface</div>
                            <div><code>Block-part</code> — a sub-part</div>
                            <div><code>Block--state</code> — a variant</div>
                        </div>
                        <div className={css.vbox(1).fontFamily("monospace").fontSize(11).color("hsl(0, 0%, 80%)")}>
                            {RS_NAMES.map(n => <div key={n}>.{n}</div>)}
                        </div>
                    </div>
                </div>
            </div>
        </div>;
    }
}
