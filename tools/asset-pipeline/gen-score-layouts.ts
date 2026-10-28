#!/usr/bin/env node --experimental-strip-types
/**
 * gen-score-layouts.ts — write the end-of-match screens (assets-free/windows/*.wnd.json):
 *
 *   ScoreScreen.wnd   pushed by GameLogic::clearGameData after a match ends or EXIT MISSION
 *                     (TheShell->push("Menus/ScoreScreen.wnd")); without it the shell stack shows
 *                     nothing and the player is left on an empty screen.
 *   PopupReplay.wnd   its SAVE REPLAY popup (Shell::getPopupReplayLayout, loaded by ScoreScreenInit).
 *
 * ScoreScreen.cpp uses without null checks: ParentScoreScreen, StaticTextGameSaveComplete,
 * ButtonSaveReplay and ButtonContinue (single player), the campaign "challenge" windows
 * (MainBackdrop, GadgetParent, BigPortrait, ChallengeWinLossText, GeneralRemarks) and, for each of
 * the 8 rows, StaticTextPlayer/Observer/UnitsBuilt/UnitsLost/UnitsDestroyed/BuildingsBuilt/
 * BuildingsLost/BuildingsDestroyed/Resources%d and GameWindowWinner%d. The chat / buddy windows are
 * network-only and checked, so they are left out. ListboxWarschoolAdvice + StaticTextWarSchool show
 * the local player's academy tips in skirmish.
 *
 * PopupReplay.cpp looks the list, name entry and buttons up from the window that got the message;
 * BACK / SAVE report to MenuButtonFrame (wnd.ts gives it the parent's system callback), so all four
 * live in that frame. PopupReplaySaved is the "Replay Saved" note, shown for a second.
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-score-layouts.ts
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
const cell = (name: string, rect: Rect, text = "") => label(name, rect, text, { staticText: { centered: true } });
const heading = (name: string, rect: Rect, text: string) =>
  label(name, rect, text, { font: ["Arial", 16, 1], headerTemplate: "Label", textColor: { enabled: [255, 214, 120, 255], enabledBorder: [0, 0, 0, 255] } });

const BACKDROP = { enabled: [10, 12, 16, 255], enabledBorder: [10, 12, 16, 255] } as const;
const PANEL = { enabled: [26, 30, 38, 240], enabledBorder: [90, 100, 120, 255] } as const;
const INNER = { enabled: [14, 16, 22, 255], enabledBorder: [70, 78, 94, 255] } as const;
const DIALOG = { enabled: [20, 24, 32, 252], enabledBorder: [200, 170, 90, 255] } as const;
const GADGET = { enabled: [34, 38, 48, 255], enabledBorder: [110, 120, 140, 255], hilite: [60, 80, 120, 255], hiliteBorder: [190, 205, 230, 255], disabled: [24, 24, 28, 255], disabledBorder: [60, 60, 66, 255] } as const;

/** Children are written relative to their parent; .wnd rects are absolute. */
const place = (ws: WindowSpec[], dx: number, dy: number): WindowSpec[] =>
  ws.map((w) => {
    const [x, y] = w.rect;
    return { ...w, rect: [x + dx, y + dy, w.rect[2], w.rect[3]] as Rect, ...(w.children ? { children: place(w.children, x + dx, y + dy) } : {}) };
  });

// ---------------------------------------------------------------------------
// ScoreScreen.wnd — full screen, a stats table over a backdrop
// ---------------------------------------------------------------------------
const G: Rect = [30, 24, 740, 420];             // GadgetParent: the table
const STATS = [
  ["UnitsBuilt", "GUI:UnitsBuilt"], ["UnitsLost", "GUI:UnitsLost"], ["UnitsDestroyed", "GUI:UnitsKilled"],
  ["BuildingsBuilt", "GUI:BuildingsBuilt"], ["BuildingsLost", "GUI:BuildingsLost"], ["BuildingsDestroyed", "GUI:BuildingsKilled"],
  ["Resources", "GUI:ResourcesCollected"],
] as const;
const COL0 = 196, COLW = 77;                    // first stat column, column width (7 × 77 = 539 → ends at 735)
const ROW0 = 96, ROWH = 36;

const table: WindowSpec[] = [
  heading("StaticTextTitle", [20, 14, 400, 28], "GX:BattleSummary"),
  label("StaticTextHeaderPlayer", [24, 56, 160, 34], "GUI:Player", { font: ["Arial", 11, 1] }),
  ...STATS.map(([key, text], c) => cell(`StaticTextHeader${key}`, [COL0 + c * COLW, 52, COLW - 4, 38], text)),
  win("RowsBackground", "USER", [12, ROW0 - 6, 716, 8 * ROWH + 8], { colors: INNER, status: ["ENABLED", "NOINPUT"] }),
];
for (let i = 0; i < 8; i++) {
  const y = ROW0 + i * ROWH;
  table.push(
    // a marker left of the name; ScoreScreen only shows / hides it
    hidden(win(`GameWindowWinner${i}`, "USER", [16, y + 6, 4, 18], { colors: { enabled: [255, 214, 120, 255], enabledBorder: [255, 214, 120, 255] }, status: ["ENABLED", "NOINPUT"] })),
    hidden(label(`StaticTextPlayer${i}`, [26, y + 4, 166, 22], "", { font: ["Arial", 12, 1] })),
    hidden(label(`StaticTextObserver${i}`, [COL0, y + 4, 300, 22], "GUI:PlayerObserver")),
    ...STATS.map(([key], c) => hidden(cell(`StaticText${key}${i}`, [COL0 + c * COLW, y + 4, COLW - 4, 22]))),
    hidden(cell(`StaticTextScore${i}`, [COL0 + 7 * COLW, y + 4, 1, 22])),   // unused (commented out in ScoreScreen.cpp)
  );
}

const score: LayoutSpec = {
  file: "ScoreScreen.wnd",
  version: 2,
  layout: { init: "ScoreScreenInit", update: "ScoreScreenUpdate", shutdown: "ScoreScreenShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    win("ParentScoreScreen", "USER", [0, 0, 800, 600], {
      system: "ScoreScreenSystem", input: "ScoreScreenInput", colors: BACKDROP,
      children: [
        win("MainBackdrop", "USER", [0, 0, 800, 600], { colors: BACKDROP, status: ["ENABLED", "NOINPUT"] }),
        win("GadgetParent", "USER", G, { colors: PANEL, status: ["ENABLED", "NOINPUT"], children: place(table, G[0], G[1]) }),
        // the local player's academy tips (skirmish)
        hidden(label("StaticTextWarSchool", [30, 452, 300, 20], "GX:Advice", { textColor: { enabled: [255, 214, 120, 255], enabledBorder: [0, 0, 0, 255] } })),
        hidden(win("ListboxWarschoolAdvice", "SCROLLLISTBOX", [30, 474, 460, 106], { listbox: { length: 20, scrollBar: true }, colors: GADGET, headerTemplate: "Small" })),
        // campaign "general's challenge" result (hidden unless a challenge map ends)
        hidden(win("BigPortrait", "USER", [60, 90, 220, 280], { colors: INNER, status: ["ENABLED", "NOINPUT"] })),
        hidden(heading("ChallengeWinLossText", [310, 100, 440, 32], "")),
        hidden(label("GeneralRemarks", [310, 150, 440, 200], "")),
        hidden(label("StaticTextGameSaveComplete", [510, 452, 260, 20], "GUI:GameSaved")),
        button("ButtonSaveReplay", [510, 486, 125, 36], "GUI:SaveReplay"),
        hidden(button("ButtonContinue", [510, 540, 125, 36], "GUI:Continue")),
        button("ButtonOk", [645, 540, 125, 36], "GUI:Ok"),
      ],
    }),
  ],
};

// ---------------------------------------------------------------------------
// PopupReplay.wnd — name the replay of the match that just ended
// ---------------------------------------------------------------------------
const R: Rect = [180, 90, 440, 420];
const replay: LayoutSpec = {
  file: "PopupReplay.wnd",
  version: 2,
  layout: { init: "PopupReplayInit", update: "PopupReplayUpdate", shutdown: "PopupReplayShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    win("PopupReplayMenu", "USER", R, {
      system: "PopupReplaySystem", input: "PopupReplayInput", colors: PANEL,
      children: place([
        heading("StaticTextTitle", [16, 12, 300, 26], "GUI:SaveReplay"),
        win("MenuButtonFrame", "USER", [0, 44, 440, 376], {
          colors: CLEAR,
          children: [
            win("ListboxGames", "SCROLLLISTBOX", [16, 0, 408, 262], { listbox: { length: 100, scrollBar: true }, colors: GADGET, headerTemplate: "Small" }),
            win("TextEntryReplayName", "ENTRYFIELD", [16, 272, 408, 28], { entry: { maxLen: 48 }, colors: GADGET, headerTemplate: "Small" }),
            button("ButtonSave", [16, 316, 196, 36], "GUI:Save"),
            button("ButtonBack", [228, 316, 196, 36], "GUI:Back"),
          ],
        }),
        hidden(win("PopupReplaySaved", "USER", [70, 150, 300, 80], {
          colors: DIALOG, status: ["ENABLED", "NOINPUT"],
          children: [label("StaticTextReplaySaved", [0, 28, 300, 24], "GUI:ReplaySaved", { staticText: { centered: true } })],
        })),
      ], R[0], R[1]),
    }),
  ],
};

for (const spec of [score, replay]) {
  const path = join(outDir, spec.file + ".json");
  writeFileSync(path, JSON.stringify(spec, null, 1) + "\n");
  console.log(`wrote ${path}`);
}
