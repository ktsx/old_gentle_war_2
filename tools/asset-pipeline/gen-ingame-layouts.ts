#!/usr/bin/env node --experimental-strip-types
/**
 * gen-ingame-layouts.ts — write the in-game popups the hotkeys open (assets-free/windows/*.wnd.json):
 *
 *   InGameChat.wnd   the chat line (InGameChat.cpp, Enter / Shift+Enter): StaticTextChatType,
 *                    TextEntryChat, ButtonClear. ShowInGameChat focuses the entry and sets its
 *                    text without a null check, so the file has to exist before Enter is bound.
 *   Diplomacy.wnd    the player list / objectives popup (Diplomacy.cpp, `): InGameParent with 8
 *                    rows (StaticTextPlayer/Side/Team/Status%d, ButtonMute%d / ButtonUnMute%d),
 *                    SoloParent with ListboxSolo (mission briefing lines), BuddiesParent and the
 *                    two radio buttons (GameSpy only, kept hidden), ButtonHide. ShowDiplomacy uses
 *                    the layout, the radio buttons and the three parents without null checks.
 *
 * Both load from the root of Window/ (winCreateFromScript("InGameChat.wnd"),
 * winCreateLayout("Diplomacy.wnd")), like the HUD layouts.
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-ingame-layouts.ts
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LayoutSpec, WindowSpec } from "./wnd.ts";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets-free", "windows");

type Rect = [number, number, number, number];
const win = (name: string, type: string, rect: Rect, extra: Partial<WindowSpec> = {}): WindowSpec =>
  ({ name, type, rect, status: ["ENABLED"], ...extra });
const hidden = (w: WindowSpec): WindowSpec => ({ ...w, status: [...(w.status ?? ["ENABLED"]), "HIDDEN"] });
const BTN = { enabled: "GxButton", disabled: "GxButtonDis", hilite: "GxButtonHi" };
const button = (name: string, rect: Rect, text: string, extra: Partial<WindowSpec> = {}) =>
  win(name, "PUSHBUTTON", rect, { text, status: ["ENABLED", "IMAGE"], images: BTN, headerTemplate: "Button", ...extra });
const CLEAR = { enabled: [0, 0, 0, 0], enabledBorder: [0, 0, 0, 0], disabled: [0, 0, 0, 0], disabledBorder: [0, 0, 0, 0] } as const;
const label = (name: string, rect: Rect, text: string, extra: Partial<WindowSpec> = {}) =>
  win(name, "STATICTEXT", rect, { headerTemplate: "Small", staticText: { centered: false }, status: ["ENABLED", "NOINPUT"], colors: CLEAR, text, ...extra });
const heading = (name: string, rect: Rect, text: string) =>
  label(name, rect, text, { font: ["Arial", 14, 1], headerTemplate: "Label", textColor: { enabled: [255, 214, 120, 255], enabledBorder: [0, 0, 0, 255] } });

const PANEL = { enabled: [26, 30, 38, 235], enabledBorder: [90, 100, 120, 255] } as const;
const INNER = { enabled: [14, 16, 22, 255], enabledBorder: [70, 78, 94, 255] } as const;
const GADGET = { enabled: [34, 38, 48, 255], enabledBorder: [110, 120, 140, 255], hilite: [60, 80, 120, 255], hiliteBorder: [190, 205, 230, 255], disabled: [24, 24, 28, 255], disabledBorder: [60, 60, 66, 255] } as const;

/** Children are written relative to their parent; .wnd rects are absolute. */
const place = (ws: WindowSpec[], dx: number, dy: number): WindowSpec[] =>
  ws.map((w) => {
    const [x, y] = w.rect;
    return { ...w, rect: [x + dx, y + dy, w.rect[2], w.rect[3]] as Rect, ...(w.children ? { children: place(w.children, x + dx, y + dy) } : {}) };
  });

// ---------------------------------------------------------------------------
// InGameChat.wnd — a line above the control bar (which starts at y = 470 of 600)
// ---------------------------------------------------------------------------
const C: Rect = [10, 430, 520, 32];
const chat: LayoutSpec = {
  file: "InGameChat.wnd",
  dir: "",
  version: 2,
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    win("InGameChatParent", "USER", C, {
      system: "InGameChatSystem", input: "InGameChatInput", colors: PANEL,
      children: place([
        label("StaticTextChatType", [8, 7, 120, 18], "Chat:Everyone", { font: ["Arial", 10, 1] }),
        win("TextEntryChat", "ENTRYFIELD", [132, 4, 300, 24], { entry: { maxLen: 120 }, colors: GADGET, headerTemplate: "Small" }),
        button("ButtonClear", [440, 3, 72, 26], "GUI:Clear"),
      ], C[0], C[1]),
    }),
  ],
};

// ---------------------------------------------------------------------------
// Diplomacy.wnd — centred over the tactical view
// ---------------------------------------------------------------------------
const D: Rect = [140, 50, 520, 400];
const LIST: Rect = [16, 70, 488, 268];          // the area the in-game rows / solo list share
const COL = { player: 8, side: 168, team: 288, status: 352, mute: 424 } as const;
const rows: WindowSpec[] = [
  label("StaticTextHeaderPlayer", [COL.player, 4, 150, 18], "GUI:Player"),
  label("StaticTextHeaderSide", [COL.side, 4, 110, 18], "GUI:Side"),
  label("StaticTextHeaderTeam", [COL.team, 4, 60, 18], "GUI:Team"),
  label("StaticTextHeaderStatus", [COL.status, 4, 70, 18], "GUI:Status"),
];
for (let i = 0; i < 8; i++) {
  const y = 28 + i * 29;
  rows.push(
    label(`StaticTextPlayer${i}`, [COL.player, y + 3, 156, 20], ""),
    label(`StaticTextSide${i}`, [COL.side, y + 3, 116, 20], ""),
    label(`StaticTextTeam${i}`, [COL.team, y + 3, 60, 20], ""),
    hidden(label(`StaticTextStatus${i}`, [COL.status, y + 3, 70, 20], "")),
    hidden(button(`ButtonMute${i}`, [COL.mute, y, 56, 24], "GUI:Mute", { font: ["Arial", 10, 1] })),
    hidden(button(`ButtonUnMute${i}`, [COL.mute, y, 56, 24], "GX:Unmute", { font: ["Arial", 10, 1] })),
  );
}
const diplomacy: LayoutSpec = {
  file: "Diplomacy.wnd",
  dir: "",
  version: 2,
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    win("DiplomacyParent", "USER", D, {
      system: "DiplomacySystem", input: "DiplomacyInput", colors: PANEL,
      children: place([
        heading("StaticTextTitle", [16, 14, 300, 24], "GX:Diplomacy"),
        hidden(win("RadioButtonInGame", "RADIOBUTTON", [16, 42, 140, 22], { text: "GX:Players", radio: { group: 1 }, colors: GADGET, headerTemplate: "Small" })),
        hidden(win("RadioButtonBuddies", "RADIOBUTTON", [164, 42, 140, 22], { text: "GUI:Buddies", radio: { group: 1 }, colors: GADGET, headerTemplate: "Small" })),
        win("InGameParent", "USER", LIST, { colors: INNER, children: rows }),
        hidden(win("SoloParent", "USER", LIST, {
          colors: INNER,
          children: [
            label("StaticTextObjectives", [8, 4, 300, 18], "GX:Objectives"),
            win("ListboxSolo", "SCROLLLISTBOX", [8, 26, 472, 234], { listbox: { length: 50, scrollBar: true }, colors: GADGET, headerTemplate: "Small" }),
          ],
        })),
        hidden(win("BuddiesParent", "USER", LIST, { colors: INNER })),
        button("ButtonHide", [520 - 16 - 140, 400 - 16 - 32, 140, 32], "GUI:Close"),
      ], D[0], D[1]),
    }),
  ],
};

for (const spec of [chat, diplomacy]) {
  const path = join(outDir, spec.file + ".json");
  writeFileSync(path, JSON.stringify(spec, null, 1) + "\n");
  console.log(`wrote ${path}`);
}
