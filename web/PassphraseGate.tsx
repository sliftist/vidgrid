import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { lockState, tryUnlock } from "./passphrase";
import { fieldInput, primaryBtn, buttonDown } from "./styles";
import { RS } from "./restyle/classNames";

@observer
export class PassphraseGate extends preact.Component<{}, {
    value: string;
    error: string;
    busy: boolean;
}> {
    state = { value: "", error: "", busy: false };

    private input: HTMLInputElement | undefined;

    componentDidMount() {
        this.input?.focus();
    }

    private submit = async () => {
        if (this.state.busy) return;
        const value = this.state.value;
        if (!value) return;
        this.setState({ busy: true, error: "" });
        let ok = false;
        try {
            ok = await tryUnlock(value);
        } catch (e) {
            this.setState({ busy: false, error: `Unlock failed: ${(e as Error).message}` });
            return;
        }
        if (ok) return;
        // Keep what was typed — a wrong passphrase is usually one wrong
        // character, and clearing it forces the whole thing to be retyped.
        this.setState({ busy: false, error: "Wrong passphrase" });
        this.input?.focus();
    };

    render() {
        const loading = lockState.get() === "loading";
        return <div className={css.fixed.left(0).right(0).top(0).bottom(0).hsl(0, 0, 7)
            .display("flex").alignItems("center").justifyContent("center").pad2(20) + RS.Page}>
            {!loading && <div className={css.vbox(10).pad(20).width(360).maxWidth("100%")
                .hsl(0, 0, 10).color("white").bord(1, "hsl(0, 0%, 22%)") + RS.Modal}>
                <div className={css.fontSize(15) + RS.ModalTitle}>vidgrid is locked</div>
                <div className={css.fontSize(11).color("hsl(0, 0%, 65%)") + RS.Muted}>
                    Enter the passphrase for this library to continue.
                </div>
                <input
                    type="text"
                    autocomplete="off"
                    value={this.state.value}
                    disabled={this.state.busy}
                    ref={el => { this.input = el ?? undefined; }}
                    onInput={(e: Event) => this.setState({ value: (e.currentTarget as HTMLInputElement).value })}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            void this.submit();
                        }
                    }}
                    className={fieldInput}
                />
                {this.state.error && <div className={css.fontSize(11).color("hsl(0, 70%, 70%)") + RS.Muted}>
                    {this.state.error}
                </div>}
                <button
                    onMouseDown={buttonDown(() => void this.submit())}
                    className={primaryBtn}
                >
                    {this.state.busy ? "Checking..." : "Unlock"}
                </button>
            </div>}
        </div>;
    }
}
