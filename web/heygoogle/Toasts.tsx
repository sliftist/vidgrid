// Transient on-screen toasts. Used to surface incoming heygoogle control
// requests so a remote (voice) command is visibly acknowledged even when the
// user isn't looking at the console. Toasts stack bottom-up and fade out on
// their own. Always mounted in browser.tsx.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { RS } from "../restyle/classNames";

const SHOW_MS = 4000;
const FADE_MS = 400;

type Toast = { id: string; message: string; leaving: boolean };

const toasts = observable.array<Toast>([]);

export function pushToast(message: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    runInAction(() => { toasts.push({ id, message, leaving: false }); });
    setTimeout(() => {
        const t = toasts.find(x => x.id === id);
        if (t) runInAction(() => { t.leaving = true; });
        setTimeout(() => {
            const i = toasts.findIndex(x => x.id === id);
            if (i >= 0) runInAction(() => { toasts.splice(i, 1); });
        }, FADE_MS);
    }, SHOW_MS);
}

@observer
export class ToastStack extends preact.Component {
    render() {
        if (toasts.length === 0) return null;
        return <div className={css.fixed.right(12).bottom(12).left(12).zIndex(4000)
            .vbox(8).alignItems("flex-end").pointerEvents("none")}>
            {toasts.map(t => <div
                key={t.id}
                className={css.pad2(14, 10).fontSize(13).maxWidth(360).minWidth(0)
                    .hsl(300, 45, 22).color("white").bord(1, "hsl(300, 60%, 50%)")
                    .overflowWrap("break-word").transition(`opacity ${FADE_MS}ms ease`)
                    .opacity(t.leaving ? 0 : 1) + RS.Toast}
            >
                {t.message}
            </div>)}
        </div>;
    }
}
