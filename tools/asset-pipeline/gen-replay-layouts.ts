#!/usr/bin/env node --experimental-strip-types
/**
 * gen-replay-layouts.ts — write the replay browser (assets-free/windows/ReplayMenu.wnd.json):
 *
 *   ReplayMenu.wnd   MAIN MENU > LOAD REPLAY > LOAD (MainMenu.cpp: TheShell->push("Menus/ReplayMenu.wnd")).
 *
 * ReplayMenu.cpp finds ParentReplayMenu, ListboxReplayFiles (used without a null check — it gets a
 * tooltip function and is filled by PopulateReplayFileListbox), ButtonLoadReplay, ButtonDeleteReplay,
 * ButtonCopyReplay and ButtonBack. The list has 4 columns — name, time + date, version, map — and the
 * GUI hack in ReplayMenuInit swaps columns 1 and 2 when the date column is the narrower one, so it is
 * made the wider. Double-clicking a row loads it. GadgetParent is optional (the init hides it).
 *
 * In the browser COPY REPLAY (copy to the desktop) downloads the file instead (ReplayMenu.cpp).
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-replay-layouts.ts
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LayoutSpec, WindowSpec } from "./wnd.ts";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets-free", "windows");

type Rect = [number, number, number, number];
const win = (name: string, type: string, rect: Rect, extra: Partial<WindowSpec> = {}): WindowSpec =>
  ({ name, type, rect, status: ["ENABLED"], ...extra });
const BTN = { enabled: "GxButton", disabled: "GxButtonDis", hilite: "GxButtonHi" };
const button = (name: string, rect: Rect, text: string, extra: Partial<WindowSpec> = {}) =>
  win(name, "PUSHBUTTON", rect, { text, status: ["ENABLED", "IMAGE"], images: BTN, headerTemplate: "Button", ...extra });
const CLEAR = { enabled: [0, 0, 0, 0], enabledBorder: [0, 0, 0, 0], disabled: [0, 0, 0, 0], disabledBorder: [0, 0, 0, 0] } as const;
const label = (name: string, rect: Rect, text: string, extra: Partial<WindowSpec> = {}) =>
  win(name, "STATICTEXT", rect, { headerTemplate: "Small", staticText: { centered: false }, status: ["ENABLED", "NOINPUT"], colors: CLEAR, text, ...extra });
const heading = (name: string, rect: Rect, text: string) =>
  label(name, rect, text, { font: ["Arial", 16, 1], headerTemplate: "Label", textColor: { enabled: [255, 214, 120, 255], enabledBorder: [0, 0, 0, 255] } });

const BACKDROP = { enabled: [10, 12, 16, 255], enabledBorder: [10, 12, 16, 255] } as const;
const PANEL = { enabled: [26, 30, 38, 240], enabledBorder: [90, 100, 120, 255] } as const;
const GADGET = { enabled: [34, 38, 48, 255], enabledBorder: [110, 120, 140, 255], hilite: [60, 80, 120, 255], hiliteBorder: [190, 205, 230, 255], disabled: [24, 24, 28, 255], disabledBorder: [60, 60, 66, 255] } as const;

/** Children are written relative to their parent; .wnd rects are absolute. */
const place = (ws: WindowSpec[], dx: number, dy: number): WindowSpec[] =>
  ws.map((w) => {
    const [x, y] = w.rect;
    return { ...w, rect: [x + dx, y + dy, w.rect[2], w.rect[3]] as Rect, ...(w.children ? { children: place(w.children, x + dx, y + dy) } : {}) };
  });

const P: Rect = [40, 30, 720, 540];             // the panel inside the full-screen parent
const LIST: Rect = [16, 70, 688, 380];
const COLS = [32, 30, 12, 26];                  // % — name, time + date (wider than version), version, map
const headers: WindowSpec[] = [];
{
  let x = LIST[0] + 4;
  const texts = ["GX:ReplayName", "GX:ReplayDate", "GX:ReplayVersion", "GX:MapPreview"];
  COLS.forEach((pct, i) => {
    const w = Math.round((LIST[2] * pct) / 100);
    headers.push(label(`StaticTextHeader${i}`, [x, 50, w - 4, 18], texts[i]));
    x += w;
  });
}

const B = 160, GAP = 12, BY = 470;
const replayMenu: LayoutSpec = {
  file: "ReplayMenu.wnd",
  version: 2,
  layout: { init: "ReplayMenuInit", update: "ReplayMenuUpdate", shutdown: "ReplayMenuShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    win("ParentReplayMenu", "USER", [0, 0, 800, 600], {
      system: "ReplayMenuSystem", input: "ReplayMenuInput", colors: BACKDROP,
      children: [
        win("ReplayPanel", "USER", P, {
          colors: PANEL, status: ["ENABLED", "NOINPUT"],
          children: place([
            heading("StaticTextTitle", [16, 14, 400, 26], "GUI:LoadReplay"),
            ...headers,
          ], P[0], P[1]),
        }),
        // the list and the buttons report to ParentReplayMenu directly
        ...place([
          win("ListboxReplayFiles", "SCROLLLISTBOX", LIST, {
            listbox: { length: 200, scrollBar: true, columns: 4, columnWidths: COLS, forceSelect: true },
            colors: GADGET, headerTemplate: "Small",
          }),
          button("ButtonLoadReplay", [16, BY, B, 36], "GUI:Load"),
          button("ButtonDeleteReplay", [16 + (B + GAP), BY, B, 36], "GUI:DeleteReplay"),
          button("ButtonCopyReplay", [16 + 2 * (B + GAP), BY, B, 36], "GX:DownloadReplay"),
          button("ButtonBack", [P[2] - 16 - B, BY, B, 36], "GUI:Back"),
        ], P[0], P[1]),
      ],
    }),
  ],
};

const path = join(outDir, replayMenu.file + ".json");
writeFileSync(path, JSON.stringify(replayMenu, null, 1) + "\n");
console.log(`wrote ${path}`);
