import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { cacheWeak } from "socket-function/src/caching";
import { characters } from "../appState";

const frameBlobUrl = cacheWeak<string, Uint8Array>((bytes: Uint8Array) =>
    URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })),
);
const urlRevoke = new FinalizationRegistry<string>(url => URL.revokeObjectURL(url));
const seenBytes = new WeakSet<Uint8Array>();
function ensureRevokeRegistered(bytes: Uint8Array, url: string) {
    if (!seenBytes.has(bytes)) {
        seenBytes.add(bytes);
        urlRevoke.register(bytes, url);
    }
}

@observer
export class FaceAvatar extends preact.Component<{
    characterKey: string;
    size: number;
    height?: number;
    onClick?: () => void;
    title?: string;
    highlighted?: boolean;
}> {
    render() {
        const size = this.props.size;
        const height = this.props.height ?? size;
        const avatarJpeg = characters.getSingleFieldSync(this.props.characterKey, "avatarJpeg");

        const baseCls = css.size(size, height).flexShrink(0).position("relative")
            + (this.props.onClick ? css.pointer : css)
            + (this.props.highlighted
                ? css.outline("1px solid hsl(50, 90%, 55%)")
                : css.outline("1px solid hsl(0, 0%, 22%)"));
        let url: string | undefined;
        if (avatarJpeg && avatarJpeg.byteLength > 0) {
            url = frameBlobUrl(avatarJpeg);
            ensureRevokeRegistered(avatarJpeg, url);
        }
        return <div
            onClick={this.props.onClick}
            title={this.props.title}
            className={baseCls + (url ? css.hsl(0, 0, 12) : css)}
        >
            {url && <img
                src={url}
                className={css.size("100%", "100%").objectFit("cover").display("block")}
            />}
        </div>;
    }
}
