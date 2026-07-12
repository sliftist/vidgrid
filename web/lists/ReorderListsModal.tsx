// Bulk reorder lists by editing each one's position number. Open from
// the EditListModal's "Reorder all lists…" button. Each row shows the
// list's name plus a number input pre-filled with its current 1-indexed
// position; changing a number and tabbing out (or pressing Enter)
// reshuffles the other lists to make room — the entire list set is
// renumbered to position * 10 so subsequent swaps keep room.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { getListsSync, setListPosition } from "./lists";
import { settingsPanelPad, modalCloseBtn, buttonDown } from "../styles";
import { RS } from "../restyle/classNames";

const reorderOpen = observable.box<boolean>(false);

export function openReorderLists() {
    runInAction(() => reorderOpen.set(true));
}

export function closeReorderLists() {
    runInAction(() => reorderOpen.set(false));
}

@observer
export class ReorderListsModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && reorderOpen.get()) {
            e.preventDefault();
            closeReorderLists();
        }
    };

    render() {
        if (!reorderOpen.get()) return null;
        const all = getListsSync();
        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) closeReorderLists(); }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(2000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20) + RS.ModalBackdrop}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white")
                    .maxWidth(720).fillWidth.maxHeight("85vh").vbox(0)
                    .bord(1, "hsl(0, 0%, 22%)").overflowHidden + RS.Modal}
            >
                <div className={settingsPanelPad + css.flexGrow(1).minHeight(0).overflowY("auto").vbox(12)}>
                <div className={css.hbox(12).alignCenter.flexShrink0}>
                    <div className={css.fontSize(15).flexGrow(1) + RS.ModalTitle}>Reorder lists</div>
                    <button
                        onMouseDown={buttonDown(() => closeReorderLists())}
                        className={modalCloseBtn}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>
                <div className={css.fontSize(11).color("hsl(0, 0%, 65%)") + RS.Muted}>
                    Type a position number and press Enter (or tab away) to move the list there. Everything else shifts to make room.
                </div>
                <div className={css.vbox(6)}>
                    {all.map((list, idx) => <ReorderRow
                        key={list.key}
                        listKey={list.key}
                        name={list.name}
                        position={idx + 1}
                        total={all.length}
                    />)}
                </div>
                </div>
            </div>
        </div>;
    }
}

@observer
class ReorderRow extends preact.Component<{
    listKey: string;
    name: string;
    position: number;
    total: number;
}> {
    synced = observable({
        // Local string state so the user can type a multi-char number
        // (e.g. "12") without us trying to apply it mid-type.
        text: String(this.props.position),
    });
    private lastPosition = this.props.position;

    componentDidUpdate() {
        // When the upstream position changes (because the user moved a
        // different list), sync the field back so it reflects truth.
        if (this.props.position !== this.lastPosition) {
            this.lastPosition = this.props.position;
            runInAction(() => { this.synced.text = String(this.props.position); });
        }
    }

    private apply = async () => {
        const n = parseInt(this.synced.text, 10);
        if (!Number.isFinite(n) || n === this.props.position) {
            runInAction(() => { this.synced.text = String(this.props.position); });
            return;
        }
        await setListPosition(this.props.listKey, n);
    };

    render() {
        const { name, total } = this.props;
        return <div className={css.hbox(8).alignCenter.pad(6).hsl(0, 0, 13)
            .bord(1, "hsl(0, 0%, 20%)") + RS.ListRow}>
            <input
                type="number"
                min={1}
                max={total}
                value={this.synced.text}
                onInput={(e: Event) => runInAction(() => {
                    this.synced.text = (e.currentTarget as HTMLInputElement).value;
                })}
                onBlur={() => void this.apply()}
                onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        void this.apply();
                        (e.currentTarget as HTMLInputElement).blur();
                    }
                }}
                className={css.pad(4).fontSize(13).bord(1, "hsl(0, 0%, 25%)")
                    .hsl(0, 0, 16).color("white").width(60).outline("none") + RS.Field}
            />
            <div className={css.fontSize(13).flexGrow(1).ellipsis} title={name}>
                {name}
            </div>
        </div>;
    }
}
