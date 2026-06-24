// Single source of truth for every stable, theme-targetable CSS class in the
// app. typesafecss generates hashed atomic classes that a theme can't reliably
// name; these plain class names are appended to those (via `css.x(...) + RS.Foo`)
// so a theme stylesheet can override the *look* (color, padding, font-size,
// borders, shadows — never layout) of each surface.
//
// Convention (see the restyling UI legend):
//   Block      — PascalCase, identical to the class string:   `Chip`
//   Block-part — a sub-part of a block (single dash):          `GridCell-title`
//   Block--state — a status/variant of a block (double dash):  `Chip--active`
//
// Each value carries a LEADING SPACE so it concatenates cleanly onto a css
// proxy or class string. NOTE: appending a string to a css proxy yields a plain
// string, so only append at the END of a css chain (after every `.method()`).

export const RS = {
    // Top-level structure / containers.
    Page: " Page",
    Sidebar: " Sidebar",
    SidebarTitle: " Sidebar-title",
    Header: " Header",
    SearchInput: " SearchInput",
    BuildChip: " BuildChip",

    // Buttons (the shared control surface + variants).
    Button: " Button",
    ButtonPrimary: " Button--primary",
    ButtonActive: " Button--active",
    ButtonDanger: " Button--danger",

    // Chips (sidebar / header pills).
    Chip: " Chip",
    ChipPrimary: " Chip--primary",
    ChipDim: " Chip--dim",
    ChipWarn: " Chip--warn",
    ChipScan: " Chip--scan",
    ChipError: " Chip--error",
    ChipHeygoogle: " Chip--heygoogle",

    // Inputs.
    Field: " Field",
    FieldDuration: " Field--duration",
    FieldClear: " Field-clear",
    Label: " Label",

    // Grid / series cells.
    GridCell: " GridCell",
    GridCellTitle: " GridCell-title",
    GridCellTitleDuration: " GridCell-title-duration",
    GridCellThumb: " GridCell-thumb",
    GridCellInfo: " GridCell-info",
    GridCellProgress: " GridCell-progress",

    // Corner badges / overlays.
    Badge: " Badge",
    BadgeError: " Badge--error",
    BadgeMedia: " Badge--media",
    BadgeReparse: " Badge--reparse",
    SeriesCount: " SeriesCount",
    GridTag: " GridTag",
    CellExpand: " CellExpand",
    TileAction: " TileAction",

    // Custom scrollbar.
    Scrollbar: " Scrollbar",
    ScrollbarThumb: " Scrollbar-thumb",
    ScrollbarLabel: " Scrollbar-label",

    // Storage file map (settings → storage expand).
    StorageMap: " StorageMap",
    StorageMapBulk: " StorageMap-bulk",
    StorageMapStream: " StorageMap-stream",
    StorageMapLoading: " StorageMap-loading",
    StorageMapSize: " StorageMap-size",

    // Modal chrome.
    Modal: " Modal",
    ModalBackdrop: " Modal-backdrop",
    ModalTitle: " Modal-title",

    // Rearrange tiles + drop indicator.
    RearrangeTile: " RearrangeTile",
    RearrangeStripe: " RearrangeTile-stripe",
    RearrangeTitle: " RearrangeTile-title",
    DropLine: " DropLine",

    // Player chrome.
    PlayerBar: " PlayerBar",
    PlayerSeek: " PlayerBar-seek",
    PlayerPill: " PlayerBar-pill",
    PlayerName: " PlayerBar-name",
    Subtitle: " Subtitle",

    // List mode + lists UI.
    ListRow: " ListRow",
    ListHeader: " ListHeader",
    ListItem: " ListItem",
    ListPanel: " ListPanel",
    KeyHint: " KeyHint",

    // Faces.
    FaceAvatar: " FaceAvatar",

    // Toasts + notifications + heygoogle management.
    Toast: " Toast",
    Card: " Card",
    Dot: " Dot",
    DotOn: " Dot--on",
    DotOff: " Dot--off",

    // Generic helpers for misc themed text / surfaces found during the pass.
    Muted: " Muted",
    Accent: " Accent",
    Surface: " Surface",
} as const;

// Trimmed, de-duplicated, sorted list of class names for the editor's reference
// panel. Derived from RS so it can never drift from what's actually used.
export const RS_NAMES: string[] = Array.from(
    new Set(Object.values(RS).map(s => s.trim())),
).sort();
