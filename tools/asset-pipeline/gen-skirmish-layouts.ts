#!/usr/bin/env node --experimental-strip-types
/**
 * gen-skirmish-layouts.ts — write the skirmish menu layout specs (assets-free/windows/*.wnd.json):
 *
 *   SkirmishGameOptionsMenu.wnd   player slots, map, options, start (SkirmishGameOptionsMenu.cpp)
 *   SkirmishMapSelectMenu.wnd     the map list popup it opens (SkirmishMapSelectMenu.cpp)
 *   MultiplayerLoadScreen.wnd     the load screen of skirmish/LAN games (MultiPlayerLoadScreen in LoadScreen.cpp)
 *                                 — without it the skirmish start dereferenced a null layout
 *
 * Every window either file's code looks up exists (grep "SkirmishGameOptionsMenu.wnd:" /
 * "SkirmishMapSelectMenu.wnd:" in GeneralsMD/Code); the map-select menu also hides a set of the
 * options menu's windows without null checks (showSkirmishGameOptionsUnderlyingGUIElements), so
 * those labels exist even where our layout does not need them. The engine populates every combo
 * box and the map list itself; the map list comes from Maps\MapCache.ini (map.ts writes it).
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-skirmish-layouts.ts
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
const label = (name: string, rect: Rect, text?: string, extra: Partial<WindowSpec> = {}) =>
  win(name, "STATICTEXT", rect, { headerTemplate: "Small", staticText: { centered: false }, status: ["ENABLED", "NOINPUT"], ...(text ? { text } : {}), ...extra });
const panel = (name: string, rect: Rect, children: WindowSpec[], extra: Partial<WindowSpec> = {}) =>
  win(name, "USER", rect, { children, ...extra });

const PANEL = { enabled: [26, 30, 38, 235], enabledBorder: [90, 100, 120, 255] } as const;
const INNER = { enabled: [14, 16, 22, 255], enabledBorder: [70, 78, 94, 255], hilite: [40, 60, 100, 255], hiliteBorder: [140, 170, 220, 255] } as const;
const CLEAR = { enabled: [0, 0, 0, 0], enabledBorder: [0, 0, 0, 0] } as const;
const GADGET = { enabled: [34, 38, 48, 255], enabledBorder: [110, 120, 140, 255], hilite: [60, 80, 120, 255], hiliteBorder: [190, 205, 230, 255], disabled: [24, 24, 28, 255], disabledBorder: [60, 60, 66, 255] } as const;

const combo = (name: string, rect: Rect, extra: Partial<WindowSpec> = {}) =>
  win(name, "COMBOBOX", rect, { headerTemplate: "Small", colors: GADGET, combo: { maxDisplay: 8, maxChars: 24 }, ...extra });

// ---------------------------------------------------------------------------
// SkirmishGameOptionsMenu.wnd
// ---------------------------------------------------------------------------
// 800x600. Left: 8 player rows (Player / Color / Side / Team); right: the map preview, map name,
// Select Map, starting cash, superweapon limit, game speed; bottom: info list, stats, buttons.
const ROW0 = 96, ROWH = 30;
const COL = { player: 24, color: 184, side: 284, team: 428, start: 500 } as const;
const slotRows: WindowSpec[] = [];
for (let i = 0; i < 8; i++) {
  const y = ROW0 + i * ROWH;
  slotRows.push(
    combo(`ComboBoxPlayer${i}`, [COL.player, y, 152, 24], { combo: { editable: i === 0, maxChars: 20, maxDisplay: 8 } }),
    combo(`ComboBoxColor${i}`, [COL.color, y, 92, 24]),
    combo(`ComboBoxPlayerTemplate${i}`, [COL.side, y, 136, 24]),
    combo(`ComboBoxTeam${i}`, [COL.team, y, 64, 24]),
    hidden(button(`ButtonStartPosition${i}`, [COL.start, y, 24, 24], "", { status: ["ENABLED"], images: undefined, headerTemplate: "Small" })),
  );
}

const MAP: Rect = [552, 96, 224, 224];
const mapStartButtons = (prefix: string, map: Rect): WindowSpec[] =>
  Array.from({ length: 8 }, (_, i) => hidden(win(`${prefix}${i}`, "PUSHBUTTON", [map[0] + 8 + (i % 4) * 24, map[1] + 8 + Math.floor(i / 4) * 24, 20, 20], { text: String(i + 1), headerTemplate: "Small", colors: GADGET })));

const skirmish: LayoutSpec = {
  file: "SkirmishGameOptionsMenu.wnd",
  version: 2,
  layout: { init: "SkirmishGameOptionsMenuInit", update: "SkirmishGameOptionsMenuUpdate", shutdown: "SkirmishGameOptionsMenuShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    panel("SkirmishGameOptionsMenuParent", [0, 0, 800, 600], [
      label("StaticTextTitle", [24, 24, 400, 28], "GUI:Skirmish", { font: ["Arial", 20, 1], headerTemplate: "Title" }),
      // column headers
      label("StaticTextPlayer", [COL.player, 72, 150, 20], "GUI:Player"),
      label("StaticTextColor", [COL.color, 72, 90, 20], "GUI:Color"),
      label("StaticTextFaction", [COL.side, 72, 130, 20], "GX:Faction"),
      label("StaticTextTeam", [COL.team, 72, 60, 20], "GUI:Team"),
      ...slotRows,
      // the local player's name (slot 0's combo box doubles as the name field in retail; the code
      // also looks this entry field up and seeds it with GUI:Player)
      hidden(win("TextEntryPlayerName", "ENTRYFIELD", [COL.player, ROW0, 152, 24], { entry: { maxLen: 20 }, colors: GADGET })),
      // map
      label("StaticTextMapPreview", [MAP[0], 72, 220, 20], "GX:MapPreview"),
      panel("MapWindow", MAP, mapStartButtons("ButtonMapStartPosition", MAP), { colors: INNER }),
      label("TextEntryMapDisplay", [MAP[0], 326, 224, 22], undefined, { colors: INNER, staticText: { centered: true } }),
      button("ButtonSelectMap", [MAP[0], 354, 224, 28], "GUI:SelectMap"),
      // options
      label("StaticTextStartingCash", [MAP[0], 392, 110, 22], "GX:StartingCash"),
      combo("ComboBoxStartingCash", [MAP[0] + 112, 392, 112, 22], { combo: { maxDisplay: 6, maxChars: 12 } }),
      win("CheckboxLimitSuperweapons", "CHECKBOX", [MAP[0], 420, 224, 22], { text: "GUI:LimitSuperweapons", headerTemplate: "Small", colors: GADGET }),
      label("StaticTextGameSpeedLabel", [MAP[0], 448, 110, 20], "GUI:GameSpeed"),
      label("StaticTextGameSpeed", [MAP[0] + 180, 448, 44, 20], undefined, { staticText: { centered: true } }),
      win("SliderGameSpeed", "HORZSLIDER", [MAP[0], 470, 172, 18], { slider: { min: 15, max: 61 }, colors: GADGET }),
      button("ButtonResetFPS", [MAP[0] + 180, 468, 44, 22], "GUI:Reset", { headerTemplate: "Small" }),
      // chat / info
      win("ListboxInfo", "SCROLLLISTBOX", [24, 340, 504, 150], { listbox: { length: 100, autoScroll: true, scrollBar: true, forceSelect: false }, colors: INNER, headerTemplate: "Small" }),
      // skirmish record (battle honours)
      label("StaticTextWins", [24, 498, 60, 20], "GUI:Wins"),
      label("StaticTextWinsValue", [84, 498, 50, 20]),
      label("StaticTextLosses", [144, 498, 60, 20], "GX:Losses"),
      label("StaticTextLossesValue", [204, 498, 50, 20]),
      label("StaticTextStreak", [264, 498, 90, 20], "GUI:WinStreak"),
      label("StaticTextStreakValue", [354, 498, 40, 20]),
      label("StaticTextBestStreak", [404, 498, 110, 20], "GUI:BestWinStreak"),
      label("StaticTextBestStreakValue", [514, 498, 40, 20]),
      // buttons
      button("ButtonBack", [24, 548, 160, 32], "GUI:Back"),
      button("ButtonReset", [200, 548, 160, 32], "GUI:Reset"),
      button("ButtonStart", [616, 548, 160, 32], "GUI:Start"),
      // hidden extras the code pokes at
      hidden(panel("SubParent", [0, 0, 1, 1], [], { colors: CLEAR })),
    ], { system: "SkirmishGameOptionsMenuSystem", input: "SkirmishGameOptionsMenuInput", colors: PANEL }),
  ],
};

// ---------------------------------------------------------------------------
// SkirmishMapSelectMenu.wnd — a popup over the options menu (it hides the map side of it)
// ---------------------------------------------------------------------------
const PREVIEW: Rect = [430, 110, 300, 300];
const mapSelect: LayoutSpec = {
  file: "SkirmishMapSelectMenu.wnd",
  version: 2,
  layout: { init: "SkirmishMapSelectMenuInit", update: "SkirmishMapSelectMenuUpdate", shutdown: "SkirmishMapSelectMenuShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    panel("SkrimishMapSelectMenuParent", [40, 60, 720, 480], [
      label("StaticTextTitle", [64, 72, 300, 28], "GX:Maps", { font: ["Arial", 20, 1], headerTemplate: "Title" }),
      win("RadioButtonSystemMaps", "RADIOBUTTON", [64, 110, 160, 22], { text: "GUI:SystemMaps", radio: { group: 1 }, headerTemplate: "Small", colors: GADGET }),
      win("RadioButtonUserMaps", "RADIOBUTTON", [234, 110, 160, 22], { text: "GUI:UserMaps", radio: { group: 1 }, headerTemplate: "Small", colors: GADGET }),
      win("ListboxMap", "SCROLLLISTBOX", [64, 140, 350, 340], { listbox: { length: 200, scrollBar: true, forceSelect: true }, colors: INNER, headerTemplate: "Small" }),
      label("StaticTextMapPreview", [PREVIEW[0], 84, 200, 20], "GX:MapPreview"),
      panel("WinMapPreview", PREVIEW, mapStartButtons("ButtonMapStartPosition", PREVIEW), { colors: INNER }),
      button("ButtonBack", [64, 494, 160, 32], "GUI:Back"),
      button("ButtonOK", [570, 494, 160, 32], "GUI:Accept"),
    ], { system: "SkirmishMapSelectMenuSystem", input: "SkirmishMapSelectMenuInput", colors: PANEL }),
  ],
};

// ---------------------------------------------------------------------------
// MultiplayerLoadScreen.wnd — one row per slot (progress bar, player, side, team), map preview,
// the local general's portrait/name/features. GameLogic::getLoadScreen picks it for GAME_SKIRMISH.
// ---------------------------------------------------------------------------
const BAR = { enabled: [30, 34, 44, 255], enabledBorder: [120, 130, 150, 255], hilite: [80, 140, 230, 255], hiliteBorder: [80, 140, 230, 255] } as const;
const LOADMAP: Rect = [480, 100, 280, 280];
const slotLines: WindowSpec[] = [];
for (let i = 0; i < 8; i++) {
  const y = 110 + i * 40;
  slotLines.push(
    label(`StaticTextPlayer${i}`, [40, y, 170, 18]),
    label(`StaticTextSide${i}`, [214, y, 130, 18]),
    label(`StaticTextTeam${i}`, [348, y, 90, 18]),
    win(`ProgressLoad${i}`, "PROGRESSBAR", [40, y + 20, 398, 12], { colors: BAR }),
  );
}
const loadScreen: LayoutSpec = {
  file: "MultiplayerLoadScreen.wnd",
  version: 2,
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    panel("MultiplayerLoadScreenParent", [0, 0, 800, 600], [
      label("StaticTextTitle", [40, 40, 400, 40], "GUI:LoadingMap", { font: ["Arial", 20, 1], headerTemplate: "Title" }),
      ...slotLines,
      panel("WinMapPreview", LOADMAP, mapStartButtons("ButtonMapStartPosition", LOADMAP), { colors: INNER }),
      win("LocalGeneralPortrait", "USER", [480, 400, 120, 120], { colors: INNER }),
      label("LocalGeneralName", [610, 400, 150, 20], undefined, { font: ["Arial", 14, 1] }),
      label("LocalGeneralFeatures", [610, 424, 150, 96]),
    ], { colors: { enabled: [12, 14, 20, 255], enabledBorder: [12, 14, 20, 255] } }),
  ],
};

for (const spec of [skirmish, mapSelect, loadScreen]) {
  const path = join(outDir, `${spec.file}.json`);
  writeFileSync(path, JSON.stringify(spec, null, 1) + "\n");
  console.log(`${path}: written`);
}
