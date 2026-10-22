#!/usr/bin/env node --experimental-strip-types
/**
 * gen-hud-layouts.ts — write the in-game HUD layout specs (assets-free/windows/*.wnd.json):
 *
 *   ControlBar.wnd              the command bar at the bottom of the screen (ControlBar.cpp & co.)
 *   GeneralsExpPoints.wnd       the generals-points popup (ControlBar::init looks up its windows at boot)
 *   GenPowersShortcutBar{US,China,GLA}.wnd   the special-power shortcut strip (PlayerTemplate SpecialPowerShortcutWinName)
 *
 * Every window name the engine looks up (grep "ControlBar.wnd:" etc. in Core/ and GeneralsMD/)
 * exists; the numbered ones come in the counts the code iterates over (MAX_COMMANDS_PER_SET 18,
 * MAX_BUILD_QUEUE_BUTTONS 9, MAX_RIGHT_HUD_UPGRADE_CAMEOS 5, observer MAX_BUTTONS 8,
 * MAX_PURCHASE_SCIENCE_RANK_1/3/8 = 4/15/4, MAX_SPECIAL_POWER_SHORTCUTS 11). Geometry is ours:
 * the tactical view is the top 480 rows of the 800x600 layout, the bar the bottom 120.
 *
 * Buttons are drawn as coloured boxes (no IMAGE status): the engine assigns cameo images at
 * runtime (GadgetButtonSetEnabledImage) and the free set has none yet, and an IMAGE button with
 * no image draws nothing at all.
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-hud-layouts.ts
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
const button = (name: string, rect: Rect, extra: Partial<WindowSpec> = {}) =>
  win(name, "PUSHBUTTON", rect, { headerTemplate: "Small", ...extra });
const label = (name: string, rect: Rect, text?: string, extra: Partial<WindowSpec> = {}) =>
  win(name, "STATICTEXT", rect, { headerTemplate: "Small", staticText: { centered: false }, ...(text ? { text } : {}), ...extra });
const panel = (name: string, rect: Rect, children: WindowSpec[], extra: Partial<WindowSpec> = {}) =>
  win(name, "USER", rect, { children, ...extra });
const nn = (i: number) => String(i).padStart(2, "0");

const PANEL = { enabled: [26, 30, 38, 255], enabledBorder: [90, 100, 120, 255] } as const;
const INNER = { enabled: [18, 20, 26, 255], enabledBorder: [70, 78, 94, 255] } as const;
const CLEAR = { enabled: [0, 0, 0, 0], enabledBorder: [0, 0, 0, 0] } as const;

// Geometry follows the retail 800x600 scheme (Data/INI/ControlBarScheme.ini, America8x6):
// ControlBarSchemeManager moves MoneyDisplay (360,438), PowerWindow (260,470), ButtonGeneral
// (719,432), ButtonLarge (646,432), ButtonOptions (184,490), ButtonIdleWorker (184,516),
// ButtonPlaceBeacon (184,545), PopupCommunicator (184,568), WinUAttack (140,412) and
// ExpBarForeground to those screen positions at runtime, so the bar's parent starts at
// y=432 (its upper 48 rows overlap the tactical view and stay transparent) and the opaque
// body is a separate window from y=470 down.
const TOP = 432, BODY = 470;

// ---------------------------------------------------------------------------
// ControlBar.wnd
// ---------------------------------------------------------------------------
const commandButtons: WindowSpec[] = [];
for (let i = 0; i < 18; i++) {
  const c = i % 6, r = Math.floor(i / 6);
  commandButtons.push(button(`ButtonCommand${nn(i + 1)}`, [234 + c * 58, 482 + r * 38, 56, 36]));
}
const queueButtons: WindowSpec[] = [];
for (let i = 0; i < 9; i++) queueButtons.push(button(`ButtonQueue${nn(i + 1)}`, [236 + i * 38, 520, 36, 36]));
const upgradeCameos: WindowSpec[] = [];
for (let i = 0; i < 5; i++) upgradeCameos.push(win(`UnitUpgrade${i + 1}`, "USER", [598 + i * 24, 568, 22, 22], { colors: INNER }));
const observerList: WindowSpec[] = [];
for (let i = 0; i < 8; i++) {
  const x = 236 + (i % 4) * 86, y = 486 + Math.floor(i / 4) * 54;
  observerList.push(button(`ButtonPlayer${i}`, [x, y, 24, 24]));
  observerList.push(label(`StaticTextPlayer${i}`, [x + 26, y, 58, 24]));
}

// The context panels share the middle of the bar; ControlBar shows one at a time.
const MID: Rect = [230, 478, 356, 118];

const controlBar: LayoutSpec = {
  file: "ControlBar.wnd",
  dir: "",
  version: 2,
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 11, 1], headerTemplate: "Small" },
  windows: [
    panel("ControlBarParent", [0, TOP, 800, 600 - TOP], [
      hidden(win("BackgroundMarker", "USER", [0, TOP, 1, 1])),
      // our own: the opaque body of the bar (everything else sits on top of it)
      win("GxBarBody", "USER", [0, BODY, 800, 600 - BODY], { colors: { enabled: [34, 38, 48, 255], enabledBorder: [110, 120, 140, 255] } }),
      // top strip (over the tactical view)
      label("MoneyDisplay", [360, 438, 80, 19], undefined, { headerTemplate: "Label", colors: { enabled: [0, 0, 0, 160], enabledBorder: [0, 0, 0, 0] } }),
      button("ButtonGeneral", [719, 432, 80, 31]),
      hidden(button("ButtonLarge", [646, 432, 72, 31])),
      hidden(button("ButtonMedium", [646, 432, 72, 31])),
      hidden(button("ButtonSmall", [646, 432, 72, 31])),
      hidden(win("WinUAttack", "USER", [140, 412, 35, 18], { colors: INNER })),
      // left: radar (W3D draws TheRadar into it)
      win("LeftHUD", "USER", [6, 476, 150, 118], { input: "LeftHUDInput", draw: "W3DLeftHUDDraw", colors: INNER }),
      win("PowerWindow", "USER", [260, 470, 278, 6], { colors: INNER }),
      panel("GeneralsExp", [160, 476, 20, 118], [
        win("ExpBarForeground", "USER", [160, 592, 20, 1], { colors: { enabled: [200, 170, 60, 255], enabledBorder: [200, 170, 60, 255] } }),
      ], { colors: INNER }),
      button("ButtonOptions", [184, 490, 36, 24], { text: "GUI:Options" }),
      button("ButtonIdleWorker", [184, 516, 36, 24], { text: "GUI:Units" }),
      hidden(button("PopupCommunicator", [184, 568, 36, 24])),
      hidden(win("WinGeneralPortrait", "USER", [600, 478, 60, 30])),
      hidden(win("TextEntryGeneralName", "ENTRYFIELD", [664, 478, 120, 20])),

      // middle: the context panels
      panel("CommandWindow", MID, commandButtons, { colors: PANEL }),
      hidden(panel("ProductionQueueWindow", MID, queueButtons, { colors: PANEL })),
      hidden(panel("UnderConstructionWindow", MID, [
        label("UnderConstructionDesc", [236, 484, 344, 40]),
        button("ButtonCancelConstruction", [236, 540, 120, 24], { text: "GUI:Cancel" }),
      ], { colors: PANEL })),
      hidden(panel("OCLTimerWindow", MID, [
        label("OCLTimerStaticText", [236, 484, 344, 20]),
        win("OCLTimerProgressBar", "PROGRESSBAR", [236, 510, 344, 16], { colors: { ...INNER, hilite: [80, 140, 230, 255], hiliteBorder: [80, 140, 230, 255] } }),
        button("OCLTimerSellButton", [236, 540, 120, 24]),
      ], { colors: PANEL })),
      hidden(panel("BeaconWindow", MID, [
        label("StaticTextBeaconLabel", [236, 484, 344, 16], "GUI:BeaconLabel"),
        win("EditBeaconText", "ENTRYFIELD", [236, 504, 344, 20], { colors: INNER }),
        button("ButtonClearBeaconText", [236, 540, 100, 22], { text: "GUI:BeaconClear" }),
        button("ButtonDeleteBeacon", [346, 540, 100, 22], { text: "GUI:DeleteBeacon" }),
        button("ButtonPlaceBeacon", [456, 540, 100, 22], { text: "GUI:Beacon" }),
      ], { input: "BeaconWindowInput", colors: PANEL })),
      hidden(panel("ObserverPlayerListWindow", MID, observerList, { colors: PANEL })),
      hidden(panel("ObserverPlayerInfoWindow", MID, [
        label("StaticTextPlayerName", [236, 484, 344, 16]),
        win("WinFlag", "USER", [236, 504, 32, 24], { colors: INNER }),
        label("StaticTextNumberOfUnits", [276, 504, 300, 14]),
        label("StaticTextNumberOfBuildings", [276, 520, 300, 14]),
        label("StaticTextNumberOfUnitsKilled", [276, 536, 300, 14]),
        label("StaticTextNumberOfUnitsLost", [276, 552, 300, 14]),
      ], { colors: PANEL })),

      // right: selected-unit portrait and upgrade cameos
      panel("RightHUD", [590, 474, 206, 122], [
        win("WinUnitSelected", "USER", [598, 480, 120, 84], { colors: INNER }),
        hidden(win("CameoWindow", "USER", [598, 480, 120, 84], { colors: INNER })),
        hidden(win("CameoMovieWindow", "USER", [598, 480, 120, 84], { colors: INNER })),
        ...upgradeCameos,
      ], { colors: PANEL }),
    ], { system: "ControlBarSystem", input: "ControlBarInput", colors: CLEAR }),
  ],
};

// ---------------------------------------------------------------------------
// GeneralsExpPoints.wnd — rank-points purchase popup
// ---------------------------------------------------------------------------
const rankButtons: WindowSpec[] = [];
for (let i = 0; i < 4; i++) rankButtons.push(button(`ButtonRank1Number${i}`, [262 + i * 70, 212, 64, 40]));
for (let i = 0; i < 15; i++) rankButtons.push(button(`ButtonRank3Number${i}`, [262 + (i % 5) * 56, 260 + Math.floor(i / 5) * 44, 52, 40]));
for (let i = 0; i < 4; i++) rankButtons.push(button(`ButtonRank8Number${i}`, [262 + i * 70, 394, 64, 40]));

const generalsExp: LayoutSpec = {
  file: "GeneralsExpPoints.wnd",
  dir: "",
  version: 2,
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 11, 1], headerTemplate: "Small" },
  windows: [
    panel("GenExpParent", [250, 120, 300, 360], [
      win("StaticTextTitle", "STATICTEXT", [260, 126, 280, 20], { text: "GUI:Generals", headerTemplate: "Subtitle" }),
      label("StaticTextLevel", [260, 150, 280, 16], "GUI:Level"),
      label("StaticTextRankPointsAvailable", [260, 168, 280, 16], "GUI:Rank"),
      win("ProgressBarExperience", "PROGRESSBAR", [260, 188, 280, 12], { colors: { ...INNER, hilite: [200, 170, 60, 255], hiliteBorder: [200, 170, 60, 255] } }),
      ...rankButtons,
      button("ButtonExit", [420, 446, 120, 26], { text: "GUI:Close" }),
    ], { system: "GeneralsExpPointsSystem", input: "GeneralsExpPointsInput", style: ["MOUSETRACK"], colors: { enabled: [24, 26, 34, 255], enabledBorder: [120, 130, 150, 255] } }),
  ],
};

// ---------------------------------------------------------------------------
// GenPowersShortcutBar<Side>.wnd — special-power shortcuts, a strip on the left edge
// ---------------------------------------------------------------------------
function shortcutBar(side: string): LayoutSpec {
  const parents: WindowSpec[] = [];
  for (let i = 0; i < 11; i++) {
    const y = 124 + i * 32;
    parents.push(panel(`ButtonParent${i + 1}`, [2, y, 56, 30], [
      button(`ButtonCommand${i + 1}`, [4, y + 2, 52, 26]),
    ], { colors: INNER }));
  }
  return {
    file: `GenPowersShortcutBar${side}.wnd`,
    dir: "",
    version: 2,
    creationResolution: [800, 600],
    defaults: { font: ["Arial", 10, 1], headerTemplate: "Small" },
    windows: [
      hidden(panel("GenPowersShortcutBarParent", [0, 120, 60, 356], parents,
        { system: "ControlBarSystem", input: "ControlBarInput", colors: { enabled: [26, 30, 38, 200], enabledBorder: [90, 100, 120, 255] } })),
    ],
  };
}

for (const spec of [controlBar, generalsExp, shortcutBar("US"), shortcutBar("China"), shortcutBar("GLA")]) {
  const path = join(outDir, spec.file + ".json");
  writeFileSync(path, JSON.stringify(spec, null, 1) + "\n");
  console.log(`${spec.file}.json written`);
}
