// Injects the active theme's CSS. Rendered as the first child of the App root
// (in <body>), so its plain `.ClassName { … }` rules win over typesafecss's
// <head> atomic rules by document order at equal specificity. @observer so it
// re-renders when the active theme or its CSS changes.
//
// Also renders the animated-background layer stack (`.rs-bg` + three child
// layers). These are stable, always-present DOM hooks that an "animated" theme
// styles + @keyframes-animates (see Palette.bgAnim in builtinCss.ts); themes
// that don't use them leave the layers transparent and inert. Putting the
// layers in the DOM (rather than an SVG background-image, which freezes) is what
// lets a theme carry a real moving wallpaper with parallax.

import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { getActiveTheme } from "./themes";
import { renderEffects } from "./effects";

@observer
export class ThemeStyle extends preact.Component {
    render() {
        const theme = getActiveTheme();
        return <preact.Fragment>
            <div className="rs-bg" aria-hidden="true">
                {renderEffects(theme?.effects)}
                <div className="rs-bg-1" />
                <div className="rs-bg-2" />
                <div className="rs-bg-3" />
            </div>
            <style>{theme?.css ?? ""}</style>
        </preact.Fragment>;
    }
}
