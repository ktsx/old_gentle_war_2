#!/usr/bin/env node --experimental-strip-types
/**
 * gen-lan-layouts.ts — write the LAN (NETWORK) menu layout specs (assets-free/windows/*.wnd.json):
 *
 *   LanLobbyMenu.wnd        games and players on the LAN, chat, player name, HOST / JOIN (LanLobbyMenu.cpp)
 *   LanGameOptionsMenu.wnd  the game room: player slots with ACCEPT, map, options, chat, START
 *                           (LanGameOptionsMenu.cpp; the slot rows are the skirmish menu's)
 *   LanMapSelectMenu.wnd    the host's map list popup (LanMapSelectMenu.cpp)
 *
 * Every window the callbacks look up exists (grep "LanLobbyMenu.wnd:" etc. in GeneralsMD/Code); the
 * map-select popup hides a set of the options menu's windows without null checks
 * (showLANGameOptionsUnderlyingGUIElements), so those labels exist too. DIRECT CONNECT needs
 * NetworkDirectConnect.wnd, which the free set does not have: the button exists, hidden.
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-lan-layouts.ts
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
const list = (name: string, rect: Rect, extra: Partial<WindowSpec> = {}) =>
  win(name, "SCROLLLISTBOX", rect, { listbox: { length: 100, scrollBar: true, forceSelect: false }, colors: INNER, headerTemplate: "Small", ...extra });
const entry = (name: string, rect: Rect, maxLen: number) =>
  win(name, "ENTRYFIELD", rect, { entry: { maxLen }, colors: GADGET, headerTemplate: "Small" });
const title = (text: string) => label("StaticTextTitle", [24, 20, 400, 30], text, { font: ["Arial", 20, 1], headerTemplate: "Title" });

const mapStartButtons = (prefix: string, map: Rect): WindowSpec[] =>
  Array.from({ length: 8 }, (_, i) => hidden(win(`${prefix}${i}`, "PUSHBUTTON", [map[0] + 8 + (i % 4) * 24, map[1] + 8 + Math.floor(i / 4) * 24, 20, 20], { text: String(i + 1), headerTemplate: "Small", colors: GADGET })));

// ---------------------------------------------------------------------------
// LanLobbyMenu.wnd — 800x600. Left: games on the LAN and their details; right: players; bottom:
// chat with its entry line; top right: the player name.
// ---------------------------------------------------------------------------
const lobby: LayoutSpec = {
  file: "LanLobbyMenu.wnd",
  version: 2,
  layout: { init: "LanLobbyMenuInit", update: "LanLobbyMenuUpdate", shutdown: "LanLobbyMenuShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    panel("LanLobbyMenuParent", [0, 0, 800, 600], [
      title("GUI:Network"),
      label("StaticTextPlayerNameLabel", [500, 28, 110, 22], "GUI:PlayerName"),
      entry("TextEntryPlayerName", [612, 26, 164, 24], 16),
      label("StaticTextGamesLabel", [24, 64, 300, 20], "GUI:Games"),
      list("ListboxGames", [24, 86, 460, 200], { listbox: { length: 50, scrollBar: true, forceSelect: true } }),
      label("StaticTextGameInfo", [24, 292, 460, 40], undefined, { colors: INNER }),
      label("StaticTextPlayersLabel", [500, 64, 276, 20], "GUI:Players"),
      list("ListboxPlayers", [500, 86, 276, 246]),
      list("ListboxChatWindowLanLobby", [24, 342, 752, 150], { listbox: { length: 200, autoScroll: true, scrollBar: true, forceSelect: false } }),
      entry("TextEntryChat", [24, 498, 652, 24], 100),
      button("ButtonEmote", [684, 496, 92, 28], "GX:Send", { headerTemplate: "Small" }),
      label("StaticToolTip", [24, 528, 752, 16]),
      // the buttons sit in GadgetParent: the menu hides it until its transition (like ReplayMenu)
      panel("GadgetParent", [0, 548, 800, 52], [
        button("ButtonBack", [24, 552, 150, 32], "GUI:Back"),
        button("ButtonClear", [190, 552, 120, 32], "GUI:Clear"),
        hidden(button("ButtonDirectConnect", [326, 552, 150, 32], "GUI:DirectConnect")),
        button("ButtonHost", [462, 552, 150, 32], "GUI:Host"),
        button("ButtonJoin", [626, 552, 150, 32], "GUI:Join"),
      ], { colors: CLEAR, status: ["ENABLED", "NOINPUT"] }),
    ], { system: "LanLobbyMenuSystem", input: "LanLobbyMenuInput", colors: PANEL }),
  ],
};

// ---------------------------------------------------------------------------
// LanGameOptionsMenu.wnd — the skirmish options layout with an ACCEPT box per slot and a chat
// ---------------------------------------------------------------------------
const ROW0 = 96, ROWH = 30;
const COL = { player: 24, color: 184, side: 284, team: 428, accept: 498, start: 530 } as const;
const slotRows: WindowSpec[] = [];
for (let i = 0; i < 8; i++) {
  const y = ROW0 + i * ROWH;
  slotRows.push(
    combo(`ComboBoxPlayer${i}`, [COL.player, y, 152, 24], { combo: { maxChars: 20, maxDisplay: 8 } }),
    combo(`ComboBoxColor${i}`, [COL.color, y, 92, 24]),
    combo(`ComboBoxPlayerTemplate${i}`, [COL.side, y, 136, 24]),
    combo(`ComboBoxTeam${i}`, [COL.team, y, 64, 24]),
    // the host's own box is a button (lit = accepted); the others show the other players' state
    win(`ButtonAccept${i}`, "PUSHBUTTON", [COL.accept, y + 2, 20, 20], { text: "", headerTemplate: "Small", colors: GADGET }),
    hidden(button(`ButtonStartPosition${i}`, [COL.start, y, 24, 24], "", { status: ["ENABLED"], images: undefined, headerTemplate: "Small" })),
  );
}
const MAP: Rect = [552, 96, 224, 224];
const options: LayoutSpec = {
  file: "LanGameOptionsMenu.wnd",
  version: 2,
  layout: { init: "LanGameOptionsMenuInit", update: "LanGameOptionsMenuUpdate", shutdown: "LanGameOptionsMenuShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    panel("LanGameOptionsMenuParent", [0, 0, 800, 600], [
      title("GUI:Network"),
      label("StaticTextPlayer", [COL.player, 72, 150, 20], "GUI:Player"),
      label("StaticTextColor", [COL.color, 72, 90, 20], "GUI:Color"),
      label("StaticTextFaction", [COL.side, 72, 130, 20], "GX:Faction"),
      label("StaticTextTeam", [COL.team, 72, 60, 20], "GUI:Team"),
      label("StaticTextAccept", [COL.accept - 12, 72, 60, 20], "GUI:Accept"),
      ...slotRows,
      // map
      label("StaticTextMapPreview", [MAP[0], 72, 220, 20], "GX:MapPreview"),
      panel("MapWindow", MAP, mapStartButtons("ButtonMapStartPosition", MAP), { colors: INNER }),
      label("TextEntryMapDisplay", [MAP[0], 326, 224, 22], undefined, { colors: INNER, staticText: { centered: true } }),
      button("ButtonSelectMap", [MAP[0], 354, 224, 28], "GUI:SelectMap"),
      label("StaticTextStartingCash", [MAP[0], 392, 110, 22], "GX:StartingCash"),
      combo("ComboBoxStartingCash", [MAP[0] + 112, 392, 112, 22], { combo: { maxDisplay: 6, maxChars: 12 } }),
      win("CheckboxLimitSuperweapons", "CHECKBOX", [MAP[0], 420, 224, 22], { text: "GUI:LimitSuperweapons", headerTemplate: "Small", colors: GADGET }),
      // chat
      list("ListboxChatWindowLanGame", [24, 344, 504, 150], { listbox: { length: 200, autoScroll: true, scrollBar: true, forceSelect: false } }),
      entry("TextEntryChat", [24, 500, 404, 24], 100),
      button("ButtonEmote", [436, 498, 92, 28], "GX:Send", { headerTemplate: "Small" }),
      // buttons
      button("ButtonBack", [24, 548, 160, 32], "GUI:Back"),
      button("ButtonStart", [616, 548, 160, 32], "GUI:Start"),
    ], { system: "LanGameOptionsMenuSystem", input: "LanGameOptionsMenuInput", colors: PANEL }),
  ],
};

// ---------------------------------------------------------------------------
// LanMapSelectMenu.wnd — a popup over the game room (it hides the map side of it)
// ---------------------------------------------------------------------------
const PREVIEW: Rect = [430, 110, 300, 300];
const mapSelect: LayoutSpec = {
  file: "LanMapSelectMenu.wnd",
  version: 2,
  layout: { init: "LanMapSelectMenuInit", update: "LanMapSelectMenuUpdate", shutdown: "LanMapSelectMenuShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    panel("LanMapSelectMenuParent", [40, 60, 720, 480], [
      label("StaticTextTitle", [64, 72, 300, 28], "GX:Maps", { font: ["Arial", 20, 1], headerTemplate: "Title" }),
      win("RadioButtonSystemMaps", "RADIOBUTTON", [64, 110, 160, 22], { text: "GUI:SystemMaps", radio: { group: 1 }, headerTemplate: "Small", colors: GADGET }),
      win("RadioButtonUserMaps", "RADIOBUTTON", [234, 110, 160, 22], { text: "GUI:UserMaps", radio: { group: 1 }, headerTemplate: "Small", colors: GADGET }),
      win("ListboxMap", "SCROLLLISTBOX", [64, 140, 350, 340], { listbox: { length: 200, scrollBar: true, forceSelect: true }, colors: INNER, headerTemplate: "Small" }),
      label("StaticTextMapPreview", [PREVIEW[0], 84, 200, 20], "GX:MapPreview"),
      panel("WinMapPreview", PREVIEW, mapStartButtons("ButtonMapStartPosition", PREVIEW), { colors: INNER }),
      button("ButtonBack", [64, 494, 160, 32], "GUI:Back"),
      button("ButtonOK", [570, 494, 160, 32], "GUI:Accept"),
    ], { system: "LanMapSelectMenuSystem", input: "LanMapSelectMenuInput", colors: PANEL }),
  ],
};

for (const spec of [lobby, options, mapSelect]) {
  const path = join(outDir, `${spec.file}.json`);
  writeFileSync(path, JSON.stringify(spec, null, 1) + "\n");
  console.log(`${path}: written`);
}
