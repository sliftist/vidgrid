// Injects the active theme's CSS. Rendered as the first child of the App root
// (in <body>), so its plain `.ClassName { … }` rules win over typesafecss's
// <head> atomic rules by document order at equal specificity. @observer so it
// re-renders when the active theme or its CSS changes.

import * as preact from "preact";
import { observer } from "sliftutils/render-utils/observer";
import { getActiveThemeCss } from "./themes";

@observer
export class ThemeStyle extends preact.Component {
    render() {
        return <style>{getActiveThemeCss()}</style>;
    }
}
