// Theme model + persistence for the restyling system. A theme is just a name
// plus a raw CSS string that targets the stable class names in `classNames.ts`
// (see RS / RS_NAMES). The active theme's CSS is injected by `ThemeStyle.tsx`
// into the App root (in <body>) so it overrides typesafecss's <head> atomic
// rules by document order — plain `.ClassName { ... }` is enough.
//
// Built-in themes are read-only: they can be cloned but not edited or deleted.
// Custom (cloned) themes live in localStorage as a JSON array.

import { observable, runInAction } from "mobx";
import {
    CYBERPUNK_CSS, FRUTIGER_AERO_CSS, CLOUDCYBER_CSS, CYBER_Y2K_CSS,
    UTOPIAN_SCHOLASTIC_CSS, WEBCORE_CSS, VAPORWAVE_CSS, TERMINAL_GREEN_CSS,
    SOLARIZED_DUSK_CSS, SUNSET_SYNTH_CSS, PAPER_INK_CSS,
    AURORA_CSS, MOLTEN_CORE_CSS, CATPPUCCIN_MOCHA_CSS, NEUBRUTALISM_CSS,
} from "./builtinCss";
import {
    CYBERPUNK_V2_CSS, FRUTIGER_AERO_V2_CSS, VAPORWAVE_V2_CSS,
    MOLTEN_CORE_V2_CSS, AURORA_V2_CSS, MOLTEN_CORE_V2_FX, AURORA_V2_FX,
    FRUTIGER_AERO_V2_FX,
} from "./builtinCssV2";
import type { ThemeEffect } from "./effects";
import { themeParam } from "../router";

export interface Theme {
    id: string;
    name: string;
    builtIn: boolean;
    css: string;
    // Config-driven animated background effects (inline SVG/DOM) rendered into
    // the `.rs-bg` stack by ThemeStyle — the kinds of effects a frozen SVG
    // background-image can't do (see effects.tsx). Serialized with custom themes.
    effects?: ThemeEffect[];
}

export const BUILTIN_THEMES: Theme[] = [
    { id: "default", name: "Default", builtIn: true, css: "" },
    { id: "cyberpunk", name: "Cyberpunk", builtIn: true, css: CYBERPUNK_CSS },
    { id: "cyberpunk-v2", name: "Cyberpunk V2", builtIn: true, css: CYBERPUNK_V2_CSS },
    { id: "cloudcyber", name: "CloudCyber", builtIn: true, css: CLOUDCYBER_CSS },
    { id: "cyber-y2k", name: "Cyber Y2K", builtIn: true, css: CYBER_Y2K_CSS },
    { id: "utopian-scholastic", name: "Utopian Scholastic", builtIn: true, css: UTOPIAN_SCHOLASTIC_CSS },
    { id: "frutiger-aero", name: "Frutiger Aero", builtIn: true, css: FRUTIGER_AERO_CSS },
    { id: "frutiger-aero-v2", name: "Frutiger Aero V2", builtIn: true, css: FRUTIGER_AERO_V2_CSS, effects: FRUTIGER_AERO_V2_FX },
    { id: "webcore", name: "Webcore", builtIn: true, css: WEBCORE_CSS },
    { id: "vaporwave", name: "Vaporwave", builtIn: true, css: VAPORWAVE_CSS },
    { id: "vaporwave-v2", name: "Vaporwave V2", builtIn: true, css: VAPORWAVE_V2_CSS },
    { id: "terminal-green", name: "Terminal Green", builtIn: true, css: TERMINAL_GREEN_CSS },
    { id: "solarized-dusk", name: "Solarized Dusk", builtIn: true, css: SOLARIZED_DUSK_CSS },
    { id: "sunset-synth", name: "Sunset Synth", builtIn: true, css: SUNSET_SYNTH_CSS },
    { id: "aurora", name: "Aurora", builtIn: true, css: AURORA_CSS },
    { id: "aurora-v2", name: "Aurora V2", builtIn: true, css: AURORA_V2_CSS, effects: AURORA_V2_FX },
    { id: "molten-core", name: "Molten Core", builtIn: true, css: MOLTEN_CORE_CSS },
    { id: "molten-core-v2", name: "Molten Core V2", builtIn: true, css: MOLTEN_CORE_V2_CSS, effects: MOLTEN_CORE_V2_FX },
    { id: "catppuccin-mocha", name: "Catppuccin Mocha", builtIn: true, css: CATPPUCCIN_MOCHA_CSS },
    { id: "neubrutalism", name: "Neubrutalism", builtIn: true, css: NEUBRUTALISM_CSS },
    { id: "paper-ink", name: "Paper Ink", builtIn: true, css: PAPER_INK_CSS },
];

const THEMES_KEY = "vidgrid.themes";
const ACTIVE_KEY = "vidgrid.activeTheme";

function newId(): string {
    return (typeof crypto !== "undefined" && "randomUUID" in crypto)
        ? crypto.randomUUID()
        : `${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

function readCustomThemes(): Theme[] {
    if (typeof localStorage === "undefined") return [];
    try {
        const raw = localStorage.getItem(THEMES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(t => t && typeof t.id === "string" && typeof t.name === "string" && typeof t.css === "string")
            .map(t => ({ id: t.id, name: t.name, builtIn: false, css: t.css, effects: Array.isArray(t.effects) ? t.effects : undefined }));
    } catch {
        return [];
    }
}

function readActiveId(): string {
    if (typeof localStorage === "undefined") return "default";
    return localStorage.getItem(ACTIVE_KEY) || "default";
}

const customThemes = observable.box<Theme[]>(readCustomThemes());
const activeThemeId = observable.box<string>(readActiveId());

function persistCustom(themes: Theme[]): void {
    if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEMES_KEY, JSON.stringify(themes.map(t => ({ id: t.id, name: t.name, css: t.css, effects: t.effects }))));
    }
    runInAction(() => customThemes.set(themes));
}

export function allThemes(): Theme[] {
    return [...BUILTIN_THEMES, ...customThemes.get()];
}

export function getActiveThemeId(): string {
    const override = themeParam.get();
    if (override) return override;
    return activeThemeId.get();
}

export function getActiveTheme(): Theme | undefined {
    const id = getActiveThemeId();
    return allThemes().find(t => t.id === id);
}

export function getActiveThemeCss(): string {
    return getActiveTheme()?.css ?? "";
}

export function setActiveTheme(id: string): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(ACTIVE_KEY, id);
    runInAction(() => activeThemeId.set(id));
}

export function cloneTheme(id: string): Theme | undefined {
    const source = allThemes().find(t => t.id === id);
    if (!source) return undefined;
    const clone: Theme = { id: newId(), name: `${source.name} (copy)`, builtIn: false, css: source.css, effects: source.effects };
    persistCustom([...customThemes.get(), clone]);
    return clone;
}

export function updateThemeCss(id: string, css: string): void {
    persistCustom(customThemes.get().map(t => (t.id === id ? { ...t, css } : t)));
}

export function renameTheme(id: string, name: string): void {
    persistCustom(customThemes.get().map(t => (t.id === id ? { ...t, name } : t)));
}

export function deleteTheme(id: string): void {
    persistCustom(customThemes.get().filter(t => t.id !== id));
    if (activeThemeId.get() === id) setActiveTheme("default");
}
