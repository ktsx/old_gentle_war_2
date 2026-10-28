#!/usr/bin/env node --experimental-strip-types
/**
 * gen-saveload-layouts.ts — write the save/load screens (assets-free/windows/*.wnd.json):
 *
 *   PopupSaveLoad.wnd   in a match: the ESC menu's SAVE/LOAD button (Shell::getSaveLoadMenuLayout,
 *                       SaveLoadMenuInit — save and load)
 *   SaveLoad.wnd        in the shell: MAIN MENU > LOAD REPLAY > LOAD GAME (TheShell->push,
 *                       SaveLoadMenuFullScreenInit — load only)
 *
 * PopupSaveLoad.cpp drives both with the same window names under each file's prefix and uses
 * most of them without a null check: SaveLoadMenu (parent, focus + modal), MenuButtonFrame with
 * ButtonSave / ButtonLoad / ButtonDelete / ButtonBack, ListboxGames (2 columns: description /
 * time, filled by GameState::populateSaveGameListbox), and four hidden dialogs —
 * OverwriteConfirmParent, LoadConfirmParent, DeleteConfirmParent (Confirm / Cancel each) and
 * SaveDescParent (EntryDesc + Confirm / Cancel). The dialogs come last so they draw on top.
 *
 * ListboxGames forces a selection: clicking the selected row would otherwise clear it and grey out
 * LOAD / DELETE. Saves go to <UserData>/save/ — /userdata, the IDBFS mount (web_pre.js), so they survive a reload.
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-saveload-layouts.ts
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

const PANEL = { enabled: [26, 30, 38, 240], enabledBorder: [90, 100, 120, 255] } as const;
const DIALOG = { enabled: [20, 24, 32, 252], enabledBorder: [200, 170, 90, 255] } as const;
const GADGET = { enabled: [34, 38, 48, 255], enabledBorder: [110, 120, 140, 255], hilite: [60, 80, 120, 255], hiliteBorder: [190, 205, 230, 255], disabled: [24, 24, 28, 255], disabledBorder: [60, 60, 66, 255] } as const;

/** Children are written relative to their parent; .wnd rects are absolute. */
const place = (ws: WindowSpec[], dx: number, dy: number): WindowSpec[] =>
  ws.map((w) => {
    const [x, y] = w.rect;
    return { ...w, rect: [x + dx, y + dy, w.rect[2], w.rect[3]] as Rect, ...(w.children ? { children: place(w.children, x + dx, y + dy) } : {}) };
  });

const P: Rect = [140, 50, 520, 470];
/** A centred yes/no dialog over the list. */
const dialog = (name: string, text: string, confirm: string, cancel: string, confirmText: string, cancelText: string, extra: WindowSpec[] = []): WindowSpec =>
  hidden(win(name, "USER", [70, 150, 380, 150], {
    colors: DIALOG,
    children: [
      label(`${name}Text`, [16, 16, 348, 40], text, { staticText: { centered: true } }),
      ...extra,
      button(confirm, [380 - 16 - 120 - 12 - 120, 100, 120, 32], confirmText),
      button(cancel, [380 - 16 - 120, 100, 120, 32], cancelText),
    ],
  }));

function saveLoad(file: string, init: string): LayoutSpec {
  return {
    file,
    version: 2,
    layout: { init, update: "SaveLoadMenuUpdate", shutdown: "SaveLoadMenuShutdown" },
    creationResolution: [800, 600],
    defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
    windows: [
      win("SaveLoadMenu", "USER", P, {
        system: "SaveLoadMenuSystem", input: "SaveLoadMenuInput", colors: PANEL,
        children: place([
          heading("StaticTextTitle", [16, 14, 300, 24], "GUI:SaveAndLoad"),
          win("ListboxGames", "SCROLLLISTBOX", [16, 48, 488, 340], {
            listbox: { length: 100, scrollBar: true, columns: 2, columnWidths: [68, 32], forceSelect: true },
            colors: GADGET, headerTemplate: "Small",
          }),
          win("MenuButtonFrame", "USER", [16, 404, 488, 48], {
            colors: CLEAR,
            children: [
              button("ButtonSave", [0, 8, 113, 32], "GUI:SaveGame"),
              button("ButtonLoad", [125, 8, 113, 32], "GUI:LoadGame"),
              button("ButtonDelete", [250, 8, 113, 32], "GUI:DeleteGame"),
              button("ButtonBack", [375, 8, 113, 32], "GUI:Back"),
            ],
          }),
          dialog("OverwriteConfirmParent", "GUI:OverwriteSaveConfirmation", "ButtonOverwriteConfirm", "ButtonOverwriteCancel", "GUI:Yes", "GUI:No"),
          dialog("LoadConfirmParent", "GUI:LoadGameConfirmation", "ButtonLoadConfirm", "ButtonLoadCancel", "GUI:Yes", "GUI:No"),
          dialog("DeleteConfirmParent", "GUI:DeleteFile", "ButtonDeleteConfirm", "ButtonDeleteCancel", "GUI:Yes", "GUI:No"),
          dialog("SaveDescParent", "GUI:EnterSaveDesc", "ButtonSaveDescConfirm", "ButtonSaveDescCancel", "GUI:Save", "GUI:Cancel", [
            win("EntryDesc", "ENTRYFIELD", [16, 56, 348, 28], { entry: { maxLen: 48 }, colors: GADGET, headerTemplate: "Small" }),
          ]),
        ], P[0], P[1]),
      }),
    ],
  };
}

for (const spec of [saveLoad("PopupSaveLoad.wnd", "SaveLoadMenuInit"), saveLoad("SaveLoad.wnd", "SaveLoadMenuFullScreenInit")]) {
  const path = join(outDir, spec.file + ".json");
  writeFileSync(path, JSON.stringify(spec, null, 1) + "\n");
  console.log(`wrote ${path}`);
}
