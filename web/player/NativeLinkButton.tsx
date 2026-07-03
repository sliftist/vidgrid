import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { controlSurface, controlSurfaceAccent, fieldInput } from "../styles";
import { RS } from "../restyle/classNames";

// "Open this file natively" affordance + a small ⚙️ to re-open the configure
// modal. The first time the user clicks 🔗 it prompts for the scheme (e.g.
// `file://`, `vlc://`) and the absolute disk path of the shared folder. We
// store both in localStorage keyed by the folder name so different folders
// can have different configs.
//
// Once set, the emoji is wrapped in an actual <a> with the resolved URL so
// middle-click opens in a new tab where the OS can take over.

export interface NativeLinkButtonProps {
    rootName: string | undefined;
    relativePath: string | undefined;
}

const LS_ROOT_PREFIX = "vidgrid.fsRoot.";
const LS_SCHEME_PREFIX = "vidgrid.fsScheme.";
const DEFAULT_SCHEME = "file://";

function rootKey(rootName: string): string { return LS_ROOT_PREFIX + rootName; }
function schemeKey(rootName: string): string { return LS_SCHEME_PREFIX + rootName; }

function getFsRoot(rootName: string | undefined): string {
    if (!rootName) return "";
    return localStorage.getItem(rootKey(rootName)) ?? "";
}
function getFsScheme(rootName: string | undefined): string {
    if (!rootName) return DEFAULT_SCHEME;
    return localStorage.getItem(schemeKey(rootName)) ?? DEFAULT_SCHEME;
}
function setFsRoot(rootName: string, value: string): void {
    localStorage.setItem(rootKey(rootName), value);
}
function setFsScheme(rootName: string, value: string): void {
    localStorage.setItem(schemeKey(rootName), value);
}

function buildUrl(scheme: string, fsRoot: string, relativePath: string): string {
    // Normalize Windows backslashes to forward, drop trailing slash. We do NOT
    // add a leading slash — the user's path is taken verbatim, so:
    //   `/Users/me/Videos` → `file:///Users/me/Videos` (3 slashes naturally)
    //   `E:/Videos`         → `file://E:/Videos`        (no extra slash added)
    const root = fsRoot.replace(/\\/g, "/").replace(/\/$/, "");
    const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
    return `${scheme}${root}/${encodedPath}`;
}

@observer
export class NativeLinkButton extends preact.Component<NativeLinkButtonProps> {
    synced = observable({
        modalOpen: false,
        schemeInput: DEFAULT_SCHEME,
        rootInput: "",
        // Bumped on save so the @observer re-renders to pick up new
        // localStorage values (we read LS lazily on each render).
        version: 0,
    });

    private openModal = () => {
        const rootName = this.props.rootName;
        runInAction(() => {
            this.synced.schemeInput = getFsScheme(rootName);
            this.synced.rootInput = getFsRoot(rootName);
            this.synced.modalOpen = true;
        });
    };

    private closeModal = () => {
        runInAction(() => { this.synced.modalOpen = false; });
    };

    private saveModal = () => {
        const rootName = this.props.rootName;
        if (rootName) {
            setFsScheme(rootName, this.synced.schemeInput.trim() || DEFAULT_SCHEME);
            setFsRoot(rootName, this.synced.rootInput.trim());
            runInAction(() => { this.synced.version++; });
        }
        this.closeModal();
    };

    render() {
        // Touch synced.version so saveModal's writes re-render this observer.
        void this.synced.version;
        const { rootName, relativePath } = this.props;
        const fsRoot = getFsRoot(rootName);
        const fsScheme = getFsScheme(rootName);
        const canOpen = !!fsRoot && !!relativePath;
        const href = canOpen ? buildUrl(fsScheme, fsRoot, relativePath!) : "#";

        const buttonStyle = controlSurface + css.pad2(8, 4).fontSize(14).minWidth(34)
            .textDecoration("none")
            .display("inline-flex").alignItems("center").justifyContent("center") + RS.Button;

        return <preact.Fragment>
            <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e: MouseEvent) => {
                    if (!canOpen) {
                        e.preventDefault();
                        this.openModal();
                    }
                    // When canOpen, let the browser handle it. Middle-click
                    // opens in a new tab; left-click on `file://` from `https://`
                    // is usually blocked but the link itself is real.
                }}
                title={canOpen
                    ? `Open natively: ${href}`
                    : "Set scheme + disk root to enable native open"}
                className={buttonStyle}
            >
                🔗
            </a>
            <button
                onClick={this.openModal}
                title="Configure native scheme + disk root"
                className={buttonStyle + css.border("none")}
            >
                ⚙️
            </button>

            {this.synced.modalOpen && <div
                data-modal="1"
                onClick={this.closeModal}
                className={css.fixed.left(0).top(0).right(0).bottom(0).zIndex(2000)
                    .hsla(0, 0, 0, 0.7).display("flex").alignItems("center").justifyContent("center") + RS.Surface}
            >
                <div
                    onClick={(e: MouseEvent) => e.stopPropagation()}
                    className={css.pad2(20).hsl(0, 0, 12).color("white").maxWidth(560).width("90vw")
                        .bord(1, "hsl(0, 0%, 25%)").vbox(12) + RS.Surface}
                >
                    <div className={css.fontSize(16).color("white") + RS.Accent}>Configure native open</div>
                    <div className={css.fontSize(12).hsl(0, 0, 70) + RS.Muted}>
                        Resolved URL is <code>{`<scheme><root>/<relativePath>`}</code>.
                        Stored in this browser's localStorage{rootName && <span> for folder <b>{rootName}</b></span>}.
                    </div>

                    <div className={css.vbox(4)}>
                        <div className={css.fontSize(11).hsl(0, 0, 60) + RS.Muted}>Scheme</div>
                        <input
                            type="text"
                            value={this.synced.schemeInput}
                            onInput={(e: Event) => runInAction(() => {
                                this.synced.schemeInput = (e.currentTarget as HTMLInputElement).value;
                            })}
                            onKeyDown={(e: KeyboardEvent) => {
                                if (e.key === "Enter") this.saveModal();
                                else if (e.key === "Escape") this.closeModal();
                            }}
                            placeholder="file://, vlc://, mpv://, …"
                            className={fieldInput}
                        />
                    </div>

                    <div className={css.vbox(4)}>
                        <div className={css.fontSize(11).hsl(0, 0, 60) + RS.Muted}>Disk root</div>
                        <input
                            type="text"
                            autoFocus
                            value={this.synced.rootInput}
                            onInput={(e: Event) => runInAction(() => {
                                this.synced.rootInput = (e.currentTarget as HTMLInputElement).value;
                            })}
                            onKeyDown={(e: KeyboardEvent) => {
                                if (e.key === "Enter") this.saveModal();
                                else if (e.key === "Escape") this.closeModal();
                            }}
                            placeholder="/Users/me/Videos  or  E:/Videos  or  C:\Videos"
                            className={fieldInput}
                        />
                    </div>

                    {/* Live preview of what we'll build, so the user can see the
                      * shape before saving. */}
                    {this.synced.rootInput && relativePath && <div className={css.fontSize(11).hsl(0, 0, 55).pad2(6, 8).hsl(0, 0, 8).bord(1, "hsl(0, 0%, 18%)") + RS.Surface}>
                        Preview: <code>{buildUrl(
                            this.synced.schemeInput.trim() || DEFAULT_SCHEME,
                            this.synced.rootInput,
                            relativePath,
                        )}</code>
                    </div>}

                    <div className={css.hbox(8).justifyContent("flex-end")}>
                        <button
                            className={controlSurface + css.pad2(12, 6).fontSize(13) + RS.Button}
                            onClick={this.closeModal}
                        >
                            Cancel
                        </button>
                        <button
                            className={controlSurfaceAccent + css.pad2(12, 6).fontSize(13) + RS.ButtonPrimary}
                            onClick={this.saveModal}
                        >
                            Save
                        </button>
                    </div>
                </div>
            </div>}
        </preact.Fragment>;
    }
}
