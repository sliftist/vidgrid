// Raw CSS for the built-in themes. These target only the stable class names in
// `classNames.ts` (RS / RS_NAMES) and touch look only — color, background,
// border, shadow, font-size — never layout. They live in <body> via
// ThemeStyle.tsx, so plain selectors override typesafecss's <head> rules.

export const CYBERPUNK_CSS = `
.Page {
    background: #05060a;
    color: #d6f8ff;
}
.Sidebar {
    background: #070a12;
    border-color: #16323a;
}
.Sidebar-title {
    color: #ff2fb9;
    text-shadow: 0 0 6px rgba(255,47,185,0.7);
}
.Header {
    background: #07090f;
    border-color: #16323a;
    color: #6ef9ff;
}
.SearchInput, .Field, .Field--duration {
    background: #0a0f17;
    color: #6ef9ff;
    border-color: #1f5560;
}
.SearchInput::placeholder, .Field::placeholder {
    color: #2f6470;
}
.Button {
    background: #0c1422;
    color: #6ef9ff;
    border-color: #1f6f7a;
}
.Button:hover {
    background: #103040;
    box-shadow: 0 0 8px rgba(110,249,255,0.5);
}
.Button--primary {
    background: #ff2fb9;
    color: #06070b;
    border-color: #ff7fd6;
    box-shadow: 0 0 10px rgba(255,47,185,0.6);
}
.Button--active {
    background: #123846;
    color: #6ef9ff;
    box-shadow: 0 0 8px rgba(110,249,255,0.6);
}
.Button--danger {
    background: #2a0712;
    color: #ff5d7a;
    border-color: #ff5d7a;
}
.Chip {
    background: #0c1422;
    color: #6ef9ff;
    border-color: #1f6f7a;
}
.Chip--primary {
    background: #ff2fb9;
    color: #06070b;
    box-shadow: 0 0 8px rgba(255,47,185,0.6);
}
.Chip--warn { background: #2a2207; color: #ffe23d; border-color: #ffe23d; }
.Chip--scan { background: #07202a; color: #6ef9ff; border-color: #6ef9ff; }
.Chip--error { background: #2a0712; color: #ff5d7a; border-color: #ff5d7a; }
.GridCell {
    background: #07090f;
    border-color: #16323a;
}
.GridCell-title { color: #d6f8ff; }
.GridCell-info { color: #4f9aa5; }
.GridCell-progress { background: #ff2fb9; box-shadow: 0 0 6px rgba(255,47,185,0.8); }
.Badge--error { background: #2a0712; color: #ff5d7a; }
.Badge--reparse { background: #07202a; color: #6ef9ff; }
.SeriesCount { background: #ff2fb9; color: #06070b; }
.GridTag { background: #0c1422; color: #6ef9ff; }
.Scrollbar { background: #07090f; }
.Scrollbar-thumb { background: #1f6f7a; }
.Scrollbar-label { color: #6ef9ff; }
.Modal {
    background: #0a0b12;
    color: #d6f8ff;
    border-color: #16323a;
    box-shadow: 0 0 30px rgba(255,47,185,0.25);
}
.Modal-backdrop { background: rgba(2,4,10,0.85); }
.Modal-title { color: #ff2fb9; text-shadow: 0 0 6px rgba(255,47,185,0.6); }
.PlayerBar { background: #07090f; border-color: #16323a; color: #6ef9ff; }
.PlayerBar-seek { background: #ff2fb9; }
.PlayerBar-pill { background: #0c1422; color: #6ef9ff; }
.ListRow, .ListItem, .ListPanel { background: #07090f; border-color: #16323a; color: #d6f8ff; }
.ListHeader { color: #ff2fb9; }
.KeyHint { background: #0c1422; color: #6ef9ff; border-color: #1f6f7a; }
.Toast, .Card { background: #0a0b12; color: #d6f8ff; border-color: #16323a; }
.Dot--on { background: #6ef9ff; box-shadow: 0 0 6px rgba(110,249,255,0.8); }
.Dot--off { background: #16323a; }
.Muted { color: #4f9aa5; }
.Accent { color: #ff2fb9; }
.FaceAvatar { border-color: #ff2fb9; box-shadow: 0 0 6px rgba(255,47,185,0.5); }
.BuildChip { background: #0c1422; color: #4f9aa5; }
`;

export const FRUTIGER_AERO_CSS = `
.Page {
    background: linear-gradient(180deg, #cdeafb 0%, #eaf7ff 40%, #ffffff 100%);
    color: #0d3b5c;
}
.Sidebar {
    background: linear-gradient(180deg, rgba(255,255,255,0.8), rgba(205,234,251,0.6));
    border-color: #b6dcf0;
}
.Sidebar-title { color: #1b6fb3; }
.Header {
    background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(225,242,252,0.7));
    border-color: #b6dcf0;
    color: #0d3b5c;
}
.SearchInput, .Field, .Field--duration {
    background: rgba(255,255,255,0.9);
    color: #0d3b5c;
    border-color: #9fcde8;
}
.SearchInput::placeholder, .Field::placeholder { color: #7fa8c0; }
.Button {
    background: linear-gradient(180deg, #ffffff 0%, #dceffb 100%);
    color: #0d3b5c;
    border-color: #9fcde8;
    box-shadow: 0 1px 2px rgba(13,59,92,0.15), inset 0 1px 0 rgba(255,255,255,0.8);
}
.Button:hover {
    background: linear-gradient(180deg, #ffffff 0%, #c8e7fa 100%);
}
.Button--primary {
    background: linear-gradient(180deg, #5cb6f5 0%, #1b7fd1 100%);
    color: #ffffff;
    border-color: #1b6fb3;
    box-shadow: 0 1px 3px rgba(27,111,179,0.4), inset 0 1px 0 rgba(255,255,255,0.5);
}
.Button--active {
    background: linear-gradient(180deg, #bfe6ff 0%, #8fcdf3 100%);
    color: #0d3b5c;
}
.Button--danger {
    background: linear-gradient(180deg, #ffd5d5 0%, #f29a9a 100%);
    color: #7a1414;
    border-color: #d97070;
}
.Chip {
    background: linear-gradient(180deg, #ffffff 0%, #e3f2fc 100%);
    color: #0d3b5c;
    border-color: #9fcde8;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
}
.Chip--primary {
    background: linear-gradient(180deg, #5cb6f5 0%, #1b7fd1 100%);
    color: #ffffff;
}
.Chip--warn { background: linear-gradient(180deg, #fff3c4 0%, #ffe27a 100%); color: #6b5400; border-color: #e0c34d; }
.Chip--scan { background: linear-gradient(180deg, #d3f0ff 0%, #9fd9f5 100%); color: #0d3b5c; border-color: #6fbde8; }
.Chip--error { background: linear-gradient(180deg, #ffd5d5 0%, #f29a9a 100%); color: #7a1414; border-color: #d97070; }
.GridCell {
    background: rgba(255,255,255,0.7);
    border-color: #cbe6f5;
    box-shadow: 0 1px 3px rgba(13,59,92,0.1);
}
.GridCell-title { color: #0d3b5c; }
.GridCell-info { color: #5c87a3; }
.GridCell-progress { background: linear-gradient(90deg, #5cb6f5, #1b7fd1); }
.Badge--error { background: #f29a9a; color: #ffffff; }
.Badge--reparse { background: #9fd9f5; color: #0d3b5c; }
.SeriesCount { background: linear-gradient(180deg, #5cb6f5, #1b7fd1); color: #ffffff; }
.GridTag { background: rgba(255,255,255,0.85); color: #0d3b5c; }
.Scrollbar { background: rgba(205,234,251,0.5); }
.Scrollbar-thumb { background: linear-gradient(180deg, #9fd9f5, #5cb6f5); }
.Scrollbar-label { color: #1b6fb3; }
.Modal {
    background: rgba(245,251,255,0.96);
    color: #0d3b5c;
    border-color: #b6dcf0;
    box-shadow: 0 8px 30px rgba(13,59,92,0.25);
}
.Modal-backdrop { background: rgba(13,59,92,0.3); }
.Modal-title { color: #1b6fb3; }
.PlayerBar {
    background: linear-gradient(180deg, rgba(255,255,255,0.95), rgba(225,242,252,0.85));
    border-color: #b6dcf0;
    color: #0d3b5c;
}
.PlayerBar-seek { background: linear-gradient(90deg, #5cb6f5, #1b7fd1); }
.PlayerBar-pill { background: rgba(255,255,255,0.85); color: #0d3b5c; }
.ListRow, .ListItem, .ListPanel { background: rgba(255,255,255,0.75); border-color: #cbe6f5; color: #0d3b5c; }
.ListHeader { color: #1b6fb3; }
.KeyHint { background: rgba(255,255,255,0.9); color: #0d3b5c; border-color: #9fcde8; }
.Toast, .Card { background: rgba(255,255,255,0.95); color: #0d3b5c; border-color: #b6dcf0; box-shadow: 0 2px 8px rgba(13,59,92,0.15); }
.Dot--on { background: #4caf50; box-shadow: 0 0 4px rgba(76,175,80,0.6); }
.Dot--off { background: #cbe6f5; }
.Muted { color: #5c87a3; }
.Accent { color: #1b7fd1; }
.FaceAvatar { border-color: #9fcde8; box-shadow: 0 1px 3px rgba(13,59,92,0.2); }
.BuildChip { background: rgba(255,255,255,0.8); color: #5c87a3; }
`;
