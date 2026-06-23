// The restyling manager. Browse view shows every theme as a card in a grid —
// custom themes first in their own section, built-ins below — each with a live
// preview of the theme rendered in an isolated iframe (themes target global
// selectors like `.Page` / `html, body`, so a sandboxed iframe is the only way
// to show many side-by-side without them bleeding into each other or the app).
// Editing a custom theme switches to a separate edit view (raw-CSS textarea +
// class reference + its own live preview) instead of cramming both at once.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { settingsPanelPad, actionBtn, chipBtn, dangerBtn, selectorBtn, selectorBtnActive, fieldInput } from "../styles";
import { playSound } from "../sounds";
import { RS, RS_NAMES } from "./classNames";
import { modalParam } from "../router";
import {
    allThemes, getActiveThemeId, setActiveTheme, cloneTheme,
    updateThemeCss, renameTheme, deleteTheme, type Theme,
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

// A miniature of the app — sidebar + header + grid of cells — using the stable
// RS class names so a theme's CSS restyles it exactly as it restyles the real
// page. Default colors here mirror the app's base look so the empty "Default"
// theme previews correctly. Layout only; theme CSS paints over it.
const PREVIEW_BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden}
.Page{width:100%;height:100%;display:flex;background:#161616;color:#e8e8ea;font-family:system-ui,sans-serif;font-size:7px}
.Sidebar{width:30%;background:#1e1e22;border-right:1px solid #2a2a30;padding:6px;display:flex;flex-direction:column;gap:4px}
.Sidebar-title{font-size:6px;text-transform:uppercase;letter-spacing:.5px;color:#888}
.Chip,.Button{background:#24242a;color:#e8e8ea;border:1px solid #3a3a42;padding:2px 4px;font-size:6px}
.Button--primary{background:hsl(220,60%,42%);color:#fff;border:1px solid hsl(220,50%,58%);padding:2px 4px;font-size:6px}
.content{flex:1;display:flex;flex-direction:column;min-width:0}
.Header{background:#1e1e22;border-bottom:1px solid #2a2a30;padding:5px;display:flex;gap:4px;align-items:center}
.SearchInput{flex:1;background:#1a1a1f;color:#e8e8ea;border:1px solid #3a3a42;padding:2px 4px;font-size:6px}
.grid{flex:1;display:grid;grid-template-columns:repeat(3,1fr);gap:3px;padding:5px}
.GridCell{background:#1c1c20;border:1px solid #2a2a30;display:flex;flex-direction:column;overflow:hidden}
.GridCell-thumb{flex:1;background:#0c0c0c;min-height:12px}
.GridCell-title{background:#000;color:#fff;font-size:6px;padding:1px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
const PREVIEW_MARKUP = `<div class="Sidebar">`
    + `<div class="Sidebar-title">Library</div>`
    + `<div class="Chip">Recent</div><div class="Chip">Tags</div>`
    + `<div class="Button--primary">Scan</div>`
    + `</div>`
    + `<div class="content">`
    + `<div class="Header"><div class="SearchInput">search…</div><div class="Button">Sort</div></div>`
    + `<div class="grid">`
    + Array.from({ length: 6 }, () =>
        `<div class="GridCell"><div class="GridCell-thumb"></div><div class="GridCell-title">clip.mp4</div></div>`).join("")
    + `</div></div>`;
const PREVIEW_SHELL = `<!doctype html><html><head><meta charset="utf-8">`
    + `<style>${PREVIEW_BASE_CSS}</style><style id="rs-theme"></style></head>`
    + `<body class="Page">${PREVIEW_MARKUP}</body></html>`;

// Renders a theme's CSS over the stable mock above. The shell srcdoc never
// changes (so no iframe reloads / flicker); the theme CSS is injected into the
// shell's empty <style id="rs-theme"> imperatively on load and whenever the css
// prop changes — making the editor preview update live as the user types.
class ThemePreview extends preact.Component<{ css: string; height: number }> {
    private ref = preact.createRef<HTMLIFrameElement>();
    private inject = () => {
        const el = this.ref.current?.contentDocument?.getElementById("rs-theme");
        if (el) el.textContent = this.props.css;
    };
    componentDidMount() {
        this.ref.current?.addEventListener("load", this.inject);
        this.inject();
    }
    componentDidUpdate() { this.inject(); }
    render() {
        return <iframe
            ref={this.ref}
            srcdoc={PREVIEW_SHELL}
            scrolling="no"
            sandbox="allow-same-origin"
            className={css.fillWidth.height(this.props.height).border("none")
                .display("block").pointerEvents("none").background("#161616")}
        />;
    }
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
            if (editingId.get()) runInAction(() => editingId.set(undefined));
            else closeRestyling();
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

    private card = (t: Theme, activeId: string) => {
        const isActive = t.id === activeId;
        return <div key={t.id} className={css.vbox(0).overflowHidden
            .bord(2, isActive ? "hsl(220, 70%, 55%)" : "hsl(0, 0%, 20%)")
            .hsl(0, 0, 13) + RS.Card}>
            <div onMouseDown={() => setActiveTheme(t.id)} className={css.pointer.relative}>
                <ThemePreview css={t.css} height={120} />
            </div>
            <div className={css.vbox(6).pad(8)}>
                <div className={css.hbox(8).alignCenter}>
                    <div className={css.flexGrow(1).fontSize(13).ellipsis}>{t.name}</div>
                    {isActive && <div className={css.fontSize(10).color("hsl(220, 80%, 70%)")}>● Active</div>}
                </div>
                <div className={css.hbox(6).alignCenter.flexWrap("wrap")}>
                    <button
                        onMouseDown={() => setActiveTheme(t.id)}
                        className={isActive ? selectorBtnActive : selectorBtn}
                    >{isActive ? "Active" : "Use"}</button>
                    <button onMouseDown={() => this.clone(t.id)} className={chipBtn}>Clone</button>
                    {!t.builtIn && <button
                        onMouseDown={() => runInAction(() => editingId.set(t.id))}
                        className={chipBtn}
                    >Edit</button>}
                    {!t.builtIn && <button
                        onMouseDown={() => this.remove(t.id, t.name)}
                        className={dangerBtn}
                    >Delete</button>}
                    {t.builtIn && <div className={css.flexGrow(1).textAlign("right")
                        .fontSize(10).color("hsl(0, 0%, 50%)")}>built-in</div>}
                </div>
            </div>
        </div>;
    };

    private grid(themes: Theme[], activeId: string) {
        return <div className={css.display("grid")
            .gridTemplateColumns("repeat(auto-fill, minmax(200px, 1fr))").gap(12)}>
            {themes.map(t => this.card(t, activeId))}
        </div>;
    }

    private renderBrowse() {
        const themes = allThemes();
        const activeId = getActiveThemeId();
        const custom = themes.filter(t => !t.builtIn);
        const builtin = themes.filter(t => t.builtIn);
        return <>
            <div className={css.hbox(12).alignCenter}>
                <div className={css.fontSize(15).flexGrow(1) + RS.ModalTitle}>Restyling</div>
                <button onMouseDown={() => closeRestyling()} className={actionBtn} title="Close (Esc)">✕</button>
            </div>
            {custom.length > 0 && <>
                <div className={css.fontSize(13).color("hsl(0, 0%, 75%)")}>Your themes</div>
                {this.grid(custom, activeId)}
            </>}
            <div className={css.fontSize(13).color("hsl(0, 0%, 75%)")}>Built-in themes</div>
            {this.grid(builtin, activeId)}
        </>;
    }

    private renderEdit(editing: Theme) {
        return <>
            <div className={css.hbox(8).alignCenter}>
                <button
                    onMouseDown={() => runInAction(() => editingId.set(undefined))}
                    className={actionBtn}
                >← Back</button>
                <input
                    className={fieldInput + css.flexGrow(1)}
                    value={editing.name}
                    onInput={e => renameTheme(editing.id, (e.target as HTMLInputElement).value)}
                />
                <button onMouseDown={() => this.remove(editing.id, editing.name)} className={dangerBtn}>Delete</button>
                <button onMouseDown={() => closeRestyling()} className={actionBtn} title="Close (Esc)">✕</button>
            </div>
            <div className={css.hbox(16).alignItems("stretch")}>
                <div className={css.vbox(8).flexGrow(1).minWidth(0)}>
                    <textarea
                        spellcheck={false}
                        value={editing.css}
                        onInput={e => updateThemeCss(editing.id, (e.target as HTMLTextAreaElement).value)}
                        className={fieldInput + css.minHeight(420).fontFamily("monospace")
                            .fontSize(12).whiteSpace("pre").resize("vertical")}
                    />
                    <div className={css.fontSize(11).color("hsl(0, 0%, 55%)")}>
                        Changes apply live. Target the class names on the right with plain CSS
                        (e.g. <code>.Chip {"{ color: #f0f; }"}</code>).
                    </div>
                </div>
                <div className={css.vbox(8).width(300).flexShrink(0)}>
                    <div className={css.fontSize(13).color("hsl(0, 0%, 75%)")}>Preview</div>
                    <div className={css.bord(1, "hsl(0, 0%, 20%)").overflowHidden + RS.Surface}>
                        <ThemePreview css={editing.css} height={180} />
                    </div>
                    <div className={css.fontSize(13).color("hsl(0, 0%, 75%)")}>Class reference</div>
                    <div className={css.fontSize(10).color("hsl(0, 0%, 55%)").vbox(2)}>
                        <div><code>Block</code> — a surface</div>
                        <div><code>Block-part</code> — a sub-part</div>
                        <div><code>Block--state</code> — a variant</div>
                    </div>
                    <div className={css.vbox(1).fontFamily("monospace").fontSize(11)
                        .color("hsl(0, 0%, 80%)").overflowAuto.maxHeight("38vh")}>
                        {RS_NAMES.map(n => <div key={n}>.{n}</div>)}
                    </div>
                </div>
            </div>
        </>;
    }

    render() {
        if (modalParam.get() !== "restyling") return null;
        const editId = editingId.get();
        const editing = allThemes().find(t => t.id === editId && !t.builtIn);
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
                    .maxWidth(980).fillWidth.maxHeight("85vh").overflowAuto
                    .bord(1, "hsl(0, 0%, 22%)").vbox(12) + RS.Modal}
            >
                {editing ? this.renderEdit(editing) : this.renderBrowse()}
            </div>
        </div>;
    }
}
