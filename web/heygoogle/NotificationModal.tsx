// On-screen notification surface for the heygoogle `notify` device command.
// A voice command routed through the server can push arbitrary (potentially
// long, multi-line) text here; it renders in a scrollable panel with newlines
// preserved. Always mounted in browser.tsx; renders null when there's nothing
// to show.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { modalCloseBtn } from "../styles";

const message = observable.box<string | undefined>(undefined);

export function openNotification(text: string) {
    runInAction(() => message.set(text));
}

export function closeNotification() {
    runInAction(() => message.set(undefined));
}

@observer
export class NotificationModal extends preact.Component {
    componentDidMount() {
        document.addEventListener("keydown", this.onKeyDown);
    }
    componentWillUnmount() {
        document.removeEventListener("keydown", this.onKeyDown);
    }
    private onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && message.get() !== undefined) {
            e.preventDefault();
            closeNotification();
        }
    };

    render() {
        const text = message.get();
        if (text === undefined) return null;
        return <div
            data-modal="1"
            onMouseDown={e => { if (e.currentTarget === e.target) closeNotification(); }}
            className={css.fixed.left(0).right(0).top(0).bottom(0).zIndex(3000)
                .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center")
                .pad2(20)}
        >
            <div
                onMouseDown={e => e.stopPropagation()}
                className={css.hsl(0, 0, 10).color("white")
                    .maxWidth(720).fillWidth.maxHeight("85vh").overflowAuto
                    .bord(1, "hsl(0, 0%, 22%)").vbox(12).pad2(20, 16)}
            >
                <div className={css.hbox(12).alignCenter}>
                    <div className={css.fontSize(15).flexGrow(1)}>Notification</div>
                    <button
                        onMouseDown={() => closeNotification()}
                        className={modalCloseBtn}
                        title="Close (Esc)"
                    >
                        ✕
                    </button>
                </div>
                <div className={css.fontSize(14).color("hsl(0, 0%, 90%)")
                    .whiteSpace("pre-wrap").overflowWrap("break-word")}>
                    {text}
                </div>
            </div>
        </div>;
    }
}
