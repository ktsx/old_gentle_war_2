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
import { HUD } from "./hud-skin.ts";

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
const CAMEO = { enabled: "GxUSA_Cameo", hilite: "GxUSA_Cameo", disabled: "GxUSA_Cameo" };

// Geometry comes from hud-skin.ts (HUD): the bar art is drawn by the ControlBarScheme
// (W3DCommandBarBackgroundDraw on the parent), the windows here are transparent holes and
// buttons on top of it. ControlBarSchemeManager moves MoneyDisplay, PowerWindow, the side
// buttons, ButtonGeneral/Large and WinUAttack to the scheme's coordinates at runtime, which
// are the same HUD values, so nothing jumps.

// ---------------------------------------------------------------------------
// ControlBar.wnd
// ---------------------------------------------------------------------------
const g = HUD.grid;
const commandButtons: WindowSpec[] = [];
for (let i = 0; i < g.cols * g.rows; i++) {
  const c = i % g.cols, r = Math.floor(i / g.cols);
  commandButtons.push(button(`ButtonCommand${nn(i + 1)}`, [g.x + c * (g.w + g.gap), g.y + r * (g.h + g.gap), g.w, g.h], { status: ["ENABLED", "IMAGE"], images: CAMEO }));
}
const queueButtons: WindowSpec[] = [];
for (let i = 0; i < 9; i++) queueButtons.push(button(`ButtonQueue${nn(i + 1)}`, [g.x + 2 + i * 40, g.y + 44, 36, 36], { status: ["ENABLED", "IMAGE"], images: { enabled: "GxUSA_Queue", hilite: "GxUSA_Queue", disabled: "GxUSA_Queue" } }));
const [px, py, pw, ph] = HUD.portrait;
const upgradeCameos: WindowSpec[] = [];
for (let i = 0; i < 5; i++) upgradeCameos.push(win(`UnitUpgrade${i + 1}`, "USER", [px + i * 24, HUD.upgradeY, 22, 22], { colors: CLEAR }));
const observerList: WindowSpec[] = [];
for (let i = 0; i < 8; i++) {
  const x = g.x + 4 + (i % 4) * 88, y = g.y + 6 + Math.floor(i / 4) * 56;
  observerList.push(button(`ButtonPlayer${i}`, [x, y, 24, 24]));
  observerList.push(label(`StaticTextPlayer${i}`, [x + 26, y, 60, 24]));
}

// The context panels share the command grid area; ControlBar shows one at a time.
const MID: Rect = [g.x - 2, g.y - 2, g.cols * (g.w + g.gap) - g.gap + 4, g.rows * (g.h + g.gap) - g.gap + 4];
const [rx, ry, rw, rh] = HUD.rightHud;
// Side buttons draw the scheme's images (ControlBarSchemeManager assigns them per state), so they
// need the IMAGE status; the .wnd carries the USA plates as the initial images.
const imgs = (n: string) => ({ status: ["ENABLED", "IMAGE"], images: { enabled: `GxUSA_${n}`, hilite: `GxUSA_${n}H`, disabled: `GxUSA_${n}I` } });
const sideBtn = (name: string, y: number, img: string, extra: Partial<WindowSpec> = {}) => button(name, [HUD.sideX, y, HUD.sideW, HUD.sideH], { ...imgs(img), ...extra });

const controlBar: LayoutSpec = {
  file: "ControlBar.wnd",
  dir: "",
  version: 2,
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 11, 1], headerTemplate: "Small" },
  windows: [
    panel("ControlBarParent", [0, HUD.barTop, 800, HUD.barHeight], [
      hidden(win("BackgroundMarker", "USER", [0, HUD.barTop, 1, 1])),
      // left: radar (W3DLeftHUDDraw renders TheRadar), the vertical experience bar, the side buttons
      win("LeftHUD", "USER", [...HUD.radar], { input: "LeftHUDInput", draw: "W3DLeftHUDDraw", colors: CLEAR }),
      panel("GeneralsExp", [...HUD.expBar], [
        win("ExpBarForeground", "USER", [HUD.expBar[0], HUD.expBar[1] + HUD.expBar[3] - 1, HUD.expBar[2], 1], { colors: CLEAR }),
      ], { colors: CLEAR }),
      sideBtn("ButtonOptions", HUD.sideY.options, "Options"),
      sideBtn("ButtonIdleWorker", HUD.sideY.worker, "Worker"),
      hidden(sideBtn("PopupCommunicator", HUD.sideY.chat, "Chat")),
      button("ButtonGeneral", [...HUD.general], imgs("General")),
      hidden(button("ButtonLarge", [...HUD.minMax])),
      hidden(button("ButtonMedium", [...HUD.minMax])),
      hidden(button("ButtonSmall", [...HUD.minMax])),
      hidden(win("WinUAttack", "USER", [...HUD.uAttack], { colors: CLEAR })),
      hidden(win("WinGeneralPortrait", "USER", [px, py, 60, 30])),
      hidden(win("TextEntryGeneralName", "ENTRYFIELD", [px + 64, py, 56, 20])),
      // status strip: money (text over the art's slot) and the power bar (W3DPowerDraw, PowerPoint* images)
      label("MoneyDisplay", [...HUD.money], undefined, { headerTemplate: "Label", colors: CLEAR }),
      win("PowerWindow", "USER", [...HUD.power], { draw: "W3DPowerDraw", colors: CLEAR }),

      // middle: the context panels
      panel("CommandWindow", MID, commandButtons, { colors: CLEAR }),
      hidden(panel("ProductionQueueWindow", MID, queueButtons, { colors: CLEAR })),
      hidden(panel("UnderConstructionWindow", MID, [
        label("UnderConstructionDesc", [g.x + 4, g.y + 4, 350, 40]),
        button("ButtonCancelConstruction", [g.x + 4, g.y + 60, 120, 24], { text: "GUI:Cancel" }),
      ], { colors: CLEAR })),
      hidden(panel("OCLTimerWindow", MID, [
        label("OCLTimerStaticText", [g.x + 4, g.y + 4, 350, 20]),
        win("OCLTimerProgressBar", "PROGRESSBAR", [g.x + 4, g.y + 30, 350, 16], { colors: { ...INNER, hilite: [80, 140, 230, 255], hiliteBorder: [80, 140, 230, 255] } }),
        button("OCLTimerSellButton", [g.x + 4, g.y + 60, 120, 24]),
      ], { colors: CLEAR })),
      hidden(panel("BeaconWindow", MID, [
        label("StaticTextBeaconLabel", [g.x + 4, g.y + 4, 350, 16], "GUI:BeaconLabel"),
        win("EditBeaconText", "ENTRYFIELD", [g.x + 4, g.y + 24, 350, 20], { colors: INNER }),
        button("ButtonClearBeaconText", [g.x + 4, g.y + 60, 100, 22], { text: "GUI:BeaconClear" }),
        button("ButtonDeleteBeacon", [g.x + 114, g.y + 60, 100, 22], { text: "GUI:DeleteBeacon" }),
        button("ButtonPlaceBeacon", [g.x + 224, g.y + 60, 100, 22], { text: "GUI:Beacon" }), // the scheme moves it to the side column with the beacon icon
      ], { input: "BeaconWindowInput", colors: CLEAR })),
      hidden(panel("ObserverPlayerListWindow", MID, observerList, { colors: PANEL })),
      hidden(panel("ObserverPlayerInfoWindow", MID, [
        label("StaticTextPlayerName", [g.x + 4, g.y + 4, 350, 16]),
        win("WinFlag", "USER", [g.x + 4, g.y + 24, 32, 24], { colors: INNER }),
        label("StaticTextNumberOfUnits", [g.x + 44, g.y + 24, 300, 14]),
        label("StaticTextNumberOfBuildings", [g.x + 44, g.y + 40, 300, 14]),
        label("StaticTextNumberOfUnitsKilled", [g.x + 44, g.y + 56, 300, 14]),
        label("StaticTextNumberOfUnitsLost", [g.x + 44, g.y + 72, 300, 14]),
      ], { colors: PANEL })),

      // right: the faction panel (RightHUDImage art), selected-unit portrait, upgrade cameos
      panel("RightHUD", [rx, ry, rw, rh], [
        win("WinUnitSelected", "USER", [px, py, pw, ph], { colors: CLEAR }),
        hidden(win("CameoWindow", "USER", [px, py, pw, ph], { colors: CLEAR })),
        hidden(win("CameoMovieWindow", "USER", [px, py, pw, ph], { colors: CLEAR })),
        ...upgradeCameos,
      ], { colors: CLEAR }),
    ], { system: "ControlBarSystem", input: "ControlBarInput", draw: "W3DCommandBarBackgroundDraw", colors: CLEAR }),
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
      button(`ButtonCommand${i + 1}`, [4, y + 2, 52, 26], { status: ["ENABLED", "IMAGE"], images: CAMEO }),
    ], { colors: CLEAR }));
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
