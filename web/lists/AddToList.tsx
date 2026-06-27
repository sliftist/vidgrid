// "Add to a list" control. Resting state is a row of list chips plus a
// small "+" button — compact, no permanent input box. Clicking the
// button replaces it inline with a 200px text field. Enter on the
// field creates a new list from the typed text (or adds to an exact
// existing match) and exits edit mode. Tab adds the highlighted
// best-match. Click any chip to toggle membership in either mode.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import {
    ListRecord, ListItemType,
    getListsSync, getItemListsSync, getListCountsSync, matchLists,
    createList, addToList, removeFromList, deleteList,
    listMemberships, RECENT_VIDEOS_LIST_KEY,
} from "./lists";
import { listPanelPad, listInputPad, listTilePad, listKeyBadgePad } from "../styles";
import { RS } from "../restyle/classNames";

@observer
export class AddToList extends preact.Component<{
    itemKey: string;
    itemType: ListItemType;
    // Optional label rendered above the chip row, used in the info
    // modal where every section gets a heading.
    heading?: string;
}> {
    private inputRef: HTMLInputElement | null = null;
    // Set true the moment startEdit() runs; cleared once we've actually
    // focused the element. Lets the ref callback grab focus the instant
    // the <input> mounts, instead of relying on a setTimeout race.
    private pendingFocus = false;
    synced = observable({
        text: "",
        editing: false,
        matchOffset: 0,
        // Delete mode — toggled by the trailing ✕ button. While on, clicking
        // a tag deletes it (after confirm) instead of toggling membership.
        deleting: false,
    });

    private exitEdit() {
        runInAction(() => {
            this.synced.editing = false;
            this.synced.text = "";
            this.synced.matchOffset = 0;
        });
    }

    private startEdit = () => {
        runInAction(() => {
            this.synced.editing = true;
            this.synced.text = "";
            this.synced.matchOffset = 0;
        });
        // The <input> doesn't exist yet — it'll be created by the next
        // render. captureInputRef runs as a ref callback the instant
        // preact mounts it; if pendingFocus is set, focus is called
        // synchronously right there.
        this.pendingFocus = true;
    };

    private captureInputRef = (r: HTMLInputElement | null) => {
        this.inputRef = r;
        if (r && this.pendingFocus) {
            this.pendingFocus = false;
            r.focus();
        }
    };

    // In delete mode a chip click removes the whole tag; otherwise it toggles
    // this item's membership. Membership is decided from an *async* read of the
    // store (not the possibly-stale sync snapshot), so a click always flips the
    // real state — fixing the "add didn't stick" flakiness.
    private onChipClick = (listKey: string, listName: string) => {
        const { itemKey, itemType } = this.props;
        if (this.synced.deleting) {
            if (!confirm(`Delete the tag "${listName}"? It will be removed from every video.`)) return;
            void deleteList(listKey);
            runInAction(() => { this.synced.deleting = false; });
            return;
        }
        void (async () => {
            const memKey = `${listKey}#${itemKey}`;
            const existing = await listMemberships.getSingleField(memKey, "itemKey");
            if (existing !== undefined) await removeFromList(listKey, itemKey);
            else await addToList(listKey, itemKey, itemType);
        })();
    };

    private onInput = (e: Event) => {
        const v = (e.currentTarget as HTMLInputElement).value;
        runInAction(() => { this.synced.text = v; this.synced.matchOffset = 0; });
    };

    private onKeyDown = (e: KeyboardEvent) => {
        const { itemKey, itemType } = this.props;
        const allLists = getListsSync().filter(l => l.key !== RECENT_VIDEOS_LIST_KEY);
        const { matches } = matchLists(this.synced.text, allLists);
        const text = this.synced.text.trim();
        const best = matches.length > 0
            ? matches[((this.synced.matchOffset % matches.length) + matches.length) % matches.length]
            : undefined;

        if (e.key === "Escape") {
            e.preventDefault();
            this.exitEdit();
            return;
        }
        if (e.key === "Tab" && best) {
            e.preventDefault();
            void addToList(best.key, itemKey, itemType);
            this.exitEdit();
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            if (!text) {
                this.exitEdit();
                return;
            }
            // createList already case-insensitively dedupes against
            // existing names — if `text` matches an existing list, it
            // returns that record; otherwise it writes a new one. In
            // both cases we add the current item to whatever comes back,
            // which is the point of typing a new name.
            void (async () => {
                try {
                    const list = await createList(text);
                    await addToList(list.key, itemKey, itemType);
                } catch (err) {
                    console.warn(`[AddToList] create+add failed for "${text}":`, err);
                }
            })();
            this.exitEdit();
            return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            if (matches.length > 1) {
                e.preventDefault();
                runInAction(() => {
                    this.synced.matchOffset += e.key === "ArrowRight" ? 1 : -1;
                });
            }
            return;
        }
    };

    // Exit edit mode on blur, but defer so a click on a list chip
    // gets a chance to fire its mousedown handler first.
    private onBlur = () => {
        setTimeout(() => this.exitEdit(), 100);
    };

    render() {
        const { itemKey } = this.props;
        const allLists = getListsSync().filter(l => l.key !== RECENT_VIDEOS_LIST_KEY);
        const memberKeys = getItemListsSync(itemKey);
        const counts = getListCountsSync();
        const editing = this.synced.editing;
        const deleting = this.synced.deleting;
        const text = this.synced.text;

        const { matches } = editing ? matchLists(text, allLists) : { matches: [] };
        const best = editing && matches.length > 0
            ? matches[((this.synced.matchOffset % matches.length) + matches.length) % matches.length]
            : undefined;

        const memberLists = allLists.filter(l => memberKeys.has(l.key) && l.key !== best?.key);
        const nonMemberLists = allLists.filter(l => !memberKeys.has(l.key) && l.key !== best?.key);

        return <div
            onMouseDown={(e: MouseEvent) => e.stopPropagation()}
            className={listPanelPad + css.vbox(6).hsl(0, 0, 12).color("white")
                .bord(1, "hsl(0, 0%, 22%)") + RS.ListPanel}
        >
            {this.props.heading && <div className={css.fontSize(11).color("hsl(0, 0%, 60%)") + RS.Muted}>
                {this.props.heading}
            </div>}
            <div className={css.hbox(4).wrap.alignCenter}>
                <CreateOrInput
                    editing={editing}
                    text={text}
                    inputRef={this.captureInputRef}
                    onStart={this.startEdit}
                    onInput={this.onInput}
                    onKeyDown={this.onKeyDown}
                    onBlur={this.onBlur}
                />
                {best && <ListBlock
                    list={best}
                    isMember={memberKeys.has(best.key)}
                    count={counts.get(best.key) ?? 0}
                    deleting={deleting}
                    highlighted
                    onClick={() => this.onChipClick(best.key, best.name)}
                />}
                {memberLists.map(l => <ListBlock
                    key={l.key}
                    list={l}
                    isMember
                    count={counts.get(l.key) ?? 0}
                    deleting={deleting}
                    onClick={() => this.onChipClick(l.key, l.name)}
                />)}
                {nonMemberLists.map(l => <ListBlock
                    key={l.key}
                    list={l}
                    isMember={false}
                    count={counts.get(l.key) ?? 0}
                    deleting={deleting}
                    onClick={() => this.onChipClick(l.key, l.name)}
                />)}
                {allLists.length > 0 && <div
                    onMouseDown={(e: MouseEvent) => { e.preventDefault(); runInAction(() => { this.synced.deleting = !this.synced.deleting; }); }}
                    title={deleting ? "Cancel delete mode" : "Delete a tag — click, then click the tag to remove it everywhere"}
                    className={listTilePad + css.hbox(4).alignCenter.pointer.fontSize(12)
                        + (deleting
                            ? css.color("white").bord(1, "hsl(0, 80%, 55%)").background("hsl(0, 60%, 28%)")
                            : css.color("hsl(0, 70%, 65%)").bord(1, "hsl(0, 50%, 40%)").background("transparent").hslhover(0, 40, 18))
                        + RS.ListItem}
                >
                    {deleting ? "Cancel" : "✕"}
                </div>}
            </div>
        </div>;
    }
}

// Single tile that lives in the same green pill in both states.
// Collapsed = just the [+]. Editing = [+ <input> Enter] in the same
// pill, input transparent so the green tile-bg shows through.
class CreateOrInput extends preact.Component<{
    editing: boolean;
    text: string;
    inputRef: (r: HTMLInputElement | null) => void;
    onStart: () => void;
    onInput: (e: Event) => void;
    onKeyDown: (e: KeyboardEvent) => void;
    onBlur: () => void;
}> {
    render() {
        const { editing, text, inputRef, onStart, onInput, onKeyDown, onBlur } = this.props;
        const baseCls = listTilePad + css.hbox(4).alignCenter
            .color("hsl(140, 70%, 75%)")
            .bord(1, "hsl(140, 50%, 45%)").background("hsl(140, 30%, 14%)");
        return <div
            onMouseDown={editing ? undefined : ((e: MouseEvent) => { e.preventDefault(); onStart(); })}
            className={baseCls + (editing
                ? css.cursor("text")
                : css.pointer.hslhover(140, 30, 20)) + RS.ListItem}
            title={editing
                ? undefined
                : "Add to a new list — click to type a name (Enter to create, Tab to pick the best match)"}
        >
            <span className={css.fontSize(14).color("hsl(140, 70%, 65%)") + RS.Accent}>+</span>
            {editing && <>
                <input
                    ref={inputRef}
                    type="text"
                    placeholder="List name…"
                    value={text}
                    onInput={onInput}
                    onKeyDown={onKeyDown}
                    onBlur={onBlur}
                    className={css.width(200).border("none").background("transparent")
                        .color("white").fontSize(13).pad(0)
                        .outline("none") + RS.Field}
                />
                <KeyBadge label="Enter" tone="create" />
            </>}
        </div>;
    }
}

class ListBlock extends preact.Component<{
    list: ListRecord;
    isMember: boolean;
    count: number;
    deleting?: boolean;
    highlighted?: boolean;
    onClick: () => void;
}> {
    render() {
        const { list, isMember, count, deleting, highlighted, onClick } = this.props;
        const cls = listTilePad + css.hbox(4).alignCenter.pointer
            .fontSize(12).color("white")
            + (deleting
                ? css.bord(1, "hsl(0, 80%, 55%)")
                : highlighted ? css.bord(1, "hsl(210, 80%, 55%)") : css.bord(1, "hsl(0, 0%, 30%)"))
            + (isMember ? css.hsl(0, 0, 16) : css.background("transparent")) + RS.ListItem;
        return <div
            onMouseDown={(e: MouseEvent) => { e.preventDefault(); onClick(); }}
            className={cls}
            title={deleting
                ? `Delete "${list.name}" (${count} item${count === 1 ? "" : "s"}) from every video`
                : isMember
                    ? `${list.name} — in this list (click to remove)`
                    : `${list.name} — click to add`}
        >
            {deleting && <span className={css.fontSize(11).color("hsl(0, 80%, 70%)") + RS.Accent}>✕</span>}
            {!deleting && isMember && <span className={css.fontSize(11).color("hsl(140, 60%, 70%)") + RS.Accent}>✓</span>}
            <span>{list.name}</span>
            <span className={css.fontSize(10).color("hsl(0, 0%, 55%)") + RS.Muted}>{count}</span>
            {highlighted && !deleting && <KeyBadge label="Tab" tone="match" />}
        </div>;
    }
}

class KeyBadge extends preact.Component<{ label: string; tone: "match" | "create" }> {
    render() {
        const { label, tone } = this.props;
        const tonedBorder = tone === "match"
            ? css.bord(1, "hsl(210, 80%, 55%)")
            : css.bord(1, "hsl(140, 60%, 50%)");
        const tonedColor = tone === "match"
            ? css.color("hsl(210, 90%, 80%)")
            : css.color("hsl(140, 80%, 80%)");
        return <span
            className={listKeyBadgePad + css.fontSize(10).marginLeft(2).lineHeight("1.4")
                + tonedBorder + tonedColor + RS.KeyHint}
        >
            {label}
        </span>;
    }
}
