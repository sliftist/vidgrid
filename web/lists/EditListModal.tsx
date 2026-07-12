// Rename-a-list modal. Opened from the ListTile in list view. Pre-fills
// the input with the current name; submit calls renameList which
// updates ListRecord.name (membership rows are keyed by listKey so they
// don't need touching). Errors render in-place.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { lists as listsDb, renameList, deleteList } from "./lists";
import { openReorderLists, closeReorderLists } from "./ReorderListsModal";
import { settingsPanelPad, modalCloseBtn, actionBtn, primaryBtn, dangerBtn, buttonDown } from "../styles";
import { RS } from "../restyle/classNames";
import { playSound } from "../sounds";

const editingListKey = observable.box<string | undefined>(undefined);

export function openEditList(listKey: string) {
    playSound("modalOpen");
    runInAction(() => editingListKey.set(listKey));
}

export function closeEditList() {
    playSound("modalClose");
    runInAction(() => editingListKey.set(undefined));
}

@observer
export class EditListModal extends preact.Component {
    synced = observable({
        text: "",
        error: undefined as string | undefined,
        saving: false,
        deleting: false,
    });
    private inputRef: HTMLInputElement | null = null;
    private lastListKey: string | undefined;

    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }

    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && editingListKey.get() !== undefined) {
            e.preventDefault();
            closeEditList();
        }
    };

    private captureInputRef = (r: HTMLInputElement | null) => {
        this.inputRef = r;
        if (r) r.focus();
    };

    private save = async (listKey: string) => {
        const name = this.synced.text.trim();
        if (!name) return;
        runInAction(() => { this.synced.saving = true; this.synced.error = undefined; });
        try {
            await renameList(listKey, name);
            closeEditList();
        } catch (err) {
            runInAction(() => { this.synced.error = (err as Error).message ?? String(err); });
        } finally {
            runInAction(() => { this.synced.saving = false; });
        }
    };

    private remove = async (listKey: string) => {
        if (this.synced.deleting) return;
        if (!confirm("Delete this list? Items stay in the library; only the list and its memberships are removed.")) return;
        runInAction(() => { this.synced.deleting = true; this.synced.error = undefined; });
        try {
            await deleteList(listKey);
            closeEditList();
        } catch (err) {
            runInAction(() => { this.synced.error = (err as Error).message ?? String(err); });
        } finally {
            runInAction(() => { this.synced.deleting = false; });
        }
    };

    render() {
        const listKey = editingListKey.get();
        if (!listKey) {
            this.lastListKey = undefined;
            return null;
        }
        // Reset the text field when the modal opens for a different list.
        if (listKey !== this.lastListKey) {
            this.lastListKey = listKey;
            const currentName = listsDb.getSingleFieldSync(listKey, "name") ?? "";
            runInAction(() => {
                this.synced.text = currentName;
                this.synced.error = undefined;
                this.synced.saving = false;
                this.synced.deleting = false;
            });
        }
        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) { e.preventDefault(); closeEditList(); } }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={settingsPanelPad + css.hsl(0, 0, 10).color("white")
                    .maxWidth(630).fillWidth.bord(1, "hsl(0, 0%, 22%)").vbox(12) + RS.Modal}
            >
                <div className={css.hbox(12).alignCenter}>
                    <div className={css.fontSize(15).flexGrow(1) + RS.ModalTitle}>Edit list</div>
                    <button
                        onMouseDown={buttonDown(() => closeEditList())}
                        className={modalCloseBtn}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>
                <input
                    ref={this.captureInputRef}
                    type="text"
                    value={this.synced.text}
                    onInput={(e: Event) => runInAction(() => {
                        this.synced.text = (e.currentTarget as HTMLInputElement).value;
                        this.synced.error = undefined;
                    })}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === "Enter") { e.preventDefault(); void this.save(listKey); }
                    }}
                    className={css.pad(8).fontSize(14).fillWidth
                        .bord(1, "hsl(0, 0%, 25%)").hsl(0, 0, 13).color("white")
                        .outline("none") + RS.Field}
                />
                {this.synced.error && <div className={css.fontSize(12).color("hsl(0, 70%, 70%)") + RS.Accent}>
                    {this.synced.error}
                </div>}
                <div className={css.hbox(8).alignCenter}>
                    <button
                        onMouseDown={buttonDown(() => void this.remove(listKey))}
                        disabled={this.synced.deleting || this.synced.saving}
                        className={dangerBtn}
                    >
                        {this.synced.deleting ? "Deleting…" : "Delete list"}
                    </button>
                    <button
                        onMouseDown={buttonDown(() => { closeEditList(); openReorderLists(); })}
                        className={actionBtn}
                        title="Open the bulk-reorder modal — pick a new position for any list"
                    >
                        Reorder all lists…
                    </button>
                    <div className={css.flexGrow(1)} />
                    <button
                        onMouseDown={buttonDown(() => closeEditList())}
                        className={actionBtn}
                    >
                        Cancel
                    </button>
                    <button
                        onMouseDown={buttonDown(() => void this.save(listKey))}
                        disabled={this.synced.saving || this.synced.deleting || !this.synced.text.trim()}
                        className={primaryBtn}
                    >
                        {this.synced.saving ? "Saving…" : "Save"}
                    </button>
                </div>
            </div>
        </div>;
    }
}
