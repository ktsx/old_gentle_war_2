#!/usr/bin/env node --experimental-strip-types
/**
 * gen-keyboard-layout.ts — write OPTIONS > KEYBOARD (assets-free/windows/KeyboardOptionsMenu.wnd.json).
 *
 * KeyboardOptionsMenu.cpp is a hotkey reference: pick a category (ComboBoxCategoryList, filled from
 * CategoryListName — labels GUI:CONTROL … GUI:DEBUG), pick a command (ListBoxCommandList, the
 * CommandMap records' DisplayName — gen-command-map.ts) and it shows the Description and the key.
 * Its init uses every control without a null check: ParentKeyboardOptionsMenu, ButtonBack,
 * ComboBoxCategoryList, ListBoxCommandList, StaticTextDescription, StaticTextCurrentHotkey,
 * ButtonResetAll, TextEntryAssignHotkey (gets its own input function) and ButtonAssign.
 *
 * Assigning was never finished in Zero Hour — the ButtonAssign handler is empty and nothing is
 * saved — so the entry field, ASSIGN and RESET ALL exist but stay hidden here.
 *
 * The combo box is declared after the list: siblings declared later draw on top, and its dropdown
 * opens over the list.
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-keyboard-layout.ts
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
const GOLD = { enabled: [255, 214, 120, 255], enabledBorder: [0, 0, 0, 255] } as const;
const heading = (name: string, rect: Rect, text: string) =>
  label(name, rect, text, { font: ["Arial", 16, 1], headerTemplate: "Label", textColor: GOLD });

const BACKDROP = { enabled: [10, 12, 16, 255], enabledBorder: [10, 12, 16, 255] } as const;
const PANEL = { enabled: [26, 30, 38, 240], enabledBorder: [90, 100, 120, 255] } as const;
const INNER = { enabled: [14, 16, 22, 255], enabledBorder: [70, 78, 94, 255] } as const;
const GADGET = { enabled: [34, 38, 48, 255], enabledBorder: [110, 120, 140, 255], hilite: [60, 80, 120, 255], hiliteBorder: [190, 205, 230, 255], disabled: [24, 24, 28, 255], disabledBorder: [60, 60, 66, 255] } as const;

/** Children are written relative to the panel; .wnd rects are absolute. */
const place = (ws: WindowSpec[], dx: number, dy: number): WindowSpec[] =>
  ws.map((w) => {
    const [x, y] = w.rect;
    return { ...w, rect: [x + dx, y + dy, w.rect[2], w.rect[3]] as Rect, ...(w.children ? { children: place(w.children, x + dx, y + dy) } : {}) };
  });

const P: Rect = [80, 40, 640, 520];
const LW = 300, RX = 340, RW = 276;            // left column width, right column x / width

const keyboard: LayoutSpec = {
  file: "KeyboardOptionsMenu.wnd",
  version: 2,
  layout: { init: "KeyboardOptionsMenuInit", update: "KeyboardOptionsMenuUpdate", shutdown: "KeyboardOptionsMenuShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    win("ParentKeyboardOptionsMenu", "USER", [0, 0, 800, 600], {
      system: "KeyboardOptionsMenuSystem", input: "KeyboardOptionsMenuInput", colors: BACKDROP,
      children: [
        win("KeyboardPanel", "USER", P, {
          colors: PANEL, status: ["ENABLED", "NOINPUT"],
          children: place([
            heading("StaticTextTitle", [24, 14, 400, 26], "GUI:KeyboardOptions"),
            win("DescriptionBox", "USER", [RX - 8, 88, RW + 16, 300], { colors: INNER, status: ["ENABLED", "NOINPUT"] }),
          ], P[0], P[1]),
        }),
        // the gadgets report to ParentKeyboardOptionsMenu directly
        ...place([
          win("ListBoxCommandList", "SCROLLLISTBOX", [24, 88, LW, 380], {
            listbox: { length: 100, scrollBar: true, forceSelect: false }, colors: GADGET, headerTemplate: "Small",
          }),
          label("StaticTextDescription", [RX, 96, RW, 60], "GUI:NULL", { staticText: { centered: false } }),
          label("StaticTextHotkeyLabel", [RX, 300, RW, 20], "GX:KeyboardHotkey", { textColor: GOLD }),
          label("StaticTextCurrentHotkey", [RX, 324, RW, 30], "GUI:NULL", { font: ["Arial", 16, 1], headerTemplate: "Label" }),
          // not functional in Zero Hour (empty ASSIGN handler, nothing saved): present, hidden
          hidden(win("TextEntryAssignHotkey", "ENTRYFIELD", [RX, 400, RW, 26], { entry: { maxLen: 32 }, colors: GADGET, headerTemplate: "Small" })),
          hidden(button("ButtonAssign", [RX, 434, 130, 32], "GUI:Assign")),
          hidden(button("ButtonResetAll", [RX + 146, 434, 130, 32], "GUI:ResetAll")),
          button("ButtonBack", [P[2] - 24 - 150, 476, 150, 32], "GUI:Back"),
          // last, so its dropdown opens over the list
          win("ComboBoxCategoryList", "COMBOBOX", [24, 52, LW, 26], { headerTemplate: "Small", colors: GADGET, combo: { maxDisplay: 8, maxChars: 24 } }),
        ], P[0], P[1]),
      ],
    }),
  ],
};

const path = join(outDir, keyboard.file + ".json");
writeFileSync(path, JSON.stringify(keyboard, null, 1) + "\n");
console.log(`wrote ${path}`);
