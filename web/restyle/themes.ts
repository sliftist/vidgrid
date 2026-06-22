// Theme model + persistence for the restyling system. A theme is just a name
// plus a raw CSS string that targets the stable class names in `classNames.ts`
// (see RS / RS_NAMES). The active theme's CSS is injected by `ThemeStyle.tsx`
// into the App root (in <body>) so it overrides typesafecss's <head> atomic
// rules by document order — plain `.ClassName { … }` is enough.
//
// Built-in themes are read-only: they can be cloned but not edited or deleted.
// Custom (cloned) themes live in localStorage as a JSON array.

import { observable, runInAction } from "mobx";
import {
    CYBERPUNK_CSS, FRUTIGER_AERO_CSS, CLOUDCYBER_CSS, CYBER_Y2K_CSS,
    UTOPIAN_SCHOLASTIC_CSS, WEBCORE_CSS, VAPORWAVE_CSS, TERMINAL_GREEN_CSS,
    SOLARIZED_DUSK_CSS, SUNSET_SYNTH_CSS, PAPER_INK_CSS,
} from "./builtinCss";
import { themeParam } from "../router";

export interface Theme {
    id: string;
    name: string;
    builtIn: boolean;
    css: string;
}

export const BUILTIN_THEMES: Theme[] = [
    { id: "default", name: "Default", builtIn: true, css: "" },
    { id: "cyberpunk", name: "Cyberpunk", builtIn: true, css: CYBERPUNK_CSS },
    { id: "cloudcyber", name: "CloudCyber", builtIn: true, css: CLOUDCYBER_CSS },
    { id: "cyber-y2k", name: "Cyber Y2K", builtIn: true, css: CYBER_Y2K_CSS },
    { id: "utopian-scholastic", name: "Utopian Scholastic", builtIn: true, css: UTOPIAN_SCHOLASTIC_CSS },
    { id: "frutiger-aero", name: "Frutiger Aero", builtIn: true, css: FRUTIGER_AERO_CSS },
    { id: "webcore", name: "Webcore", builtIn: true, css: WEBCORE_CSS },
    { id: "vaporwave", name: "Vaporwave", builtIn: true, css: VAPORWAVE_CSS },
    { id: "terminal-green", name: "Terminal Green", builtIn: true, css: TERMINAL_GREEN_CSS },
    { id: "solarized-dusk", name: "Solarized Dusk", builtIn: true, css: SOLARIZED_DUSK_CSS },
    { id: "sunset-synth", name: "Sunset Synth", builtIn: true, css: SUNSET_SYNTH_CSS },
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
            .map(t => ({ id: t.id, name: t.name, builtIn: false, css: t.css }));
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
        localStorage.setItem(THEMES_KEY, JSON.stringify(themes.map(t => ({ id: t.id, name: t.name, css: t.css }))));
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

export function getActiveThemeCss(): string {
    const id = getActiveThemeId();
    const theme = allThemes().find(t => t.id === id);
    return theme ? theme.css : "";
}

export function setActiveTheme(id: string): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(ACTIVE_KEY, id);
    runInAction(() => activeThemeId.set(id));
}

export function cloneTheme(id: string): Theme | undefined {
    const source = allThemes().find(t => t.id === id);
    if (!source) return undefined;
    const clone: Theme = { id: newId(), name: `${source.name} (copy)`, builtIn: false, css: source.css };
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
