#!/usr/bin/env node --experimental-strip-types
/**
 * wnd.ts — generate SAGE `.wnd` window layouts from a compact JSON spec.
 *
 * The engine parses .wnd files in
 * Core/GameEngine/Source/GameClient/GUI/GameWindowManagerScript.cpp. The format
 * is verbose (every window carries three 9-entry draw-data tables, six text
 * colours, four callbacks, ...), so the free asset set describes layouts as
 * JSON and this tool expands them. Everything the parser needs is emitted;
 * everything it defaults is optional in the spec.
 *
 * Spec:
 * {
 *   "file": "MainMenu.wnd",                  // decorated-name prefix: "MainMenu.wnd:ButtonExit"
 *   "layout": { "init": "MainMenuInit", "update": "MainMenuUpdate", "shutdown": "MainMenuShutdown" },
 *   "creationResolution": [800, 600],
 *   "defaults": { "font": ["Arial", 12, 1], "headerTemplate": "Button",
 *                 "colors": { ...see Colors... }, "textColor": { ...see TextColor... } },
 *   "windows": [ Window, ... ]               // top-level windows (usually one parent)
 * }
 * Window:
 * {
 *   "name": "MainMenuParent",                // bare name; prefixed with file
 *   "type": "USER" | "PUSHBUTTON" | "STATICTEXT" | ...,
 *   "rect": [x, y, w, h],                    // in creation-resolution pixels, screen coords
 *   "status": ["ENABLED", "IMAGE", "HIDDEN", ...],
 *   "style": ["MOUSETRACK", ...],            // the type's own style bit is added automatically
 *   "text": "GUI:SinglePlayer",              // string-table label
 *   "system": "MainMenuSystem", "input": "MainMenuInput", "tooltip": "[None]", "draw": "[None]",
 *   "font": ["Arial", 12, 1], "headerTemplate": "Button",
 *   "colors": Colors, "textColor": TextColor,
 *   "images": { "enabled": "GxButton", "disabled": "GxButtonDis", "hilite": "GxButtonHi" },  // MappedImage names, entry 0; needs "IMAGE" in status
 *   "staticText": { "centered": true },
 *   "children": [ Window, ... ]
 * }
 * Colors:    { "enabled": [r,g,b,a], "enabledBorder": [..], "disabled": [..], "disabledBorder": [..],
 *              "hilite": [..], "hiliteBorder": [..] }     (draw-data entry 0; entries 1..8 get the same)
 * TextColor: { "enabled": [..], "enabledBorder": [..], "disabled": [..], "disabledBorder": [..],
 *              "hilite": [..], "hiliteBorder": [..] }
 *
 * Usage:
 *   node --experimental-strip-types wnd.ts build <spec.json> <out.wnd>
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type RGBA = [number, number, number, number];
export interface Colors {
  enabled?: RGBA; enabledBorder?: RGBA; disabled?: RGBA; disabledBorder?: RGBA; hilite?: RGBA; hiliteBorder?: RGBA;
}
export interface WindowSpec {
  name: string;
  type: string;
  rect: [number, number, number, number];
  status?: string[];
  style?: string[];
  text?: string;
  system?: string; input?: string; tooltip?: string; draw?: string;
  font?: [string, number, number];
  headerTemplate?: string;
  colors?: Colors;
  textColor?: Colors;
  /** MappedImage names for draw-data entry 0 of each state (add "IMAGE" to status to use them). */
  images?: { enabled?: string; disabled?: string; hilite?: string };
  staticText?: { centered?: boolean };
  entry?: { maxLen?: number };
  tooltipDelay?: number;
  children?: WindowSpec[];
}
export interface LayoutSpec {
  file: string;
  /** Subdirectory under Window/ the engine loads this layout from: menus live in "Menus", the in-game HUD at the root (""). Default "Menus". */
  dir?: string;
  version?: number;
  layout?: { init?: string; update?: string; shutdown?: string };
  creationResolution?: [number, number];
  defaults?: Partial<Pick<WindowSpec, "font" | "headerTemplate" | "colors" | "textColor" | "tooltipDelay">>;
  windows: WindowSpec[];
}

const DEFAULT_COLORS: Required<Colors> = {
  enabled: [40, 44, 52, 255], enabledBorder: [120, 130, 150, 255],
  disabled: [30, 30, 30, 255], disabledBorder: [70, 70, 70, 255],
  hilite: [70, 90, 130, 255], hiliteBorder: [200, 210, 230, 255],
};
const DEFAULT_TEXT: Required<Colors> = {
  enabled: [230, 230, 230, 255], enabledBorder: [0, 0, 0, 255],
  disabled: [120, 120, 120, 255], disabledBorder: [0, 0, 0, 255],
  hilite: [255, 255, 160, 255], hiliteBorder: [0, 0, 0, 255],
};

/** Style bit implied by the window type (the parser does not add it for us). */
const TYPE_STYLE: Record<string, string> = {
  USER: "USER", PUSHBUTTON: "PUSHBUTTON", RADIOBUTTON: "RADIOBUTTON", CHECKBOX: "CHECKBOX",
  VERTSLIDER: "VERTSLIDER", HORZSLIDER: "HORZSLIDER", SCROLLLISTBOX: "SCROLLLISTBOX",
  ENTRYFIELD: "ENTRYFIELD", STATICTEXT: "STATICTEXT", PROGRESSBAR: "PROGRESSBAR",
  TABCONTROL: "TABCONTROL", TABPANE: "TABPANE", COMBOBOX: "COMBOBOX",
};

const rgba = (c: RGBA) => c.join(" ");

function drawData(label: string, c: Required<Colors>, state: "enabled" | "disabled" | "hilite", image?: string): string {
  const color = c[state];
  const border = c[`${state}Border` as keyof Colors] as RGBA;
  const entry = (img: string) => `IMAGE: ${img}, COLOR: ${rgba(color)}, BORDERCOLOR: ${rgba(border)}`;
  const entries = Array.from({ length: 9 }, (_, i) => entry(i === 0 && image ? image : "NoImage"));
  return `  ${label} = ${entries.join(",\n" + " ".repeat(label.length + 5))};`;
}

function emitWindow(w: WindowSpec, spec: LayoutSpec, out: string[], indent: string): void {
  const d = spec.defaults ?? {};
  const [cw, ch] = spec.creationResolution ?? [800, 600];
  const [x, y, width, height] = w.rect;
  const colors = { ...DEFAULT_COLORS, ...(d.colors ?? {}), ...(w.colors ?? {}) } as Required<Colors>;
  const text = { ...DEFAULT_TEXT, ...(d.textColor ?? {}), ...(w.textColor ?? {}) } as Required<Colors>;
  const font = w.font ?? d.font ?? ["Arial", 12, 1];
  const header = w.headerTemplate ?? d.headerTemplate ?? "[None]";
  const typeStyle = TYPE_STYLE[w.type] ?? "USER";
  const style = Array.from(new Set([typeStyle, ...(w.style ?? [])]));
  const status = w.status ?? ["ENABLED"];
  const name = w.name.includes(":") ? w.name : `${spec.file}:${w.name}`;

  const L = (s: string) => out.push(indent + s);
  L("WINDOW");
  L(`  WINDOWTYPE = ${w.type};`);
  L(`  SCREENRECT = UPPERLEFT: ${x} ${y},`);
  L(`               BOTTOMRIGHT: ${x + width} ${y + height},`);
  L(`               CREATIONRESOLUTION: ${cw} ${ch};`);
  L(`  NAME = "${name}";`);
  L(`  STATUS = ${status.join("+")};`);
  L(`  STYLE = ${style.join("+")};`);
  L(`  SYSTEMCALLBACK = "${w.system ?? "[None]"}";`);
  L(`  INPUTCALLBACK = "${w.input ?? "[None]"}";`);
  L(`  TOOLTIPCALLBACK = "${w.tooltip ?? "[None]"}";`);
  L(`  DRAWCALLBACK = "${w.draw ?? "[None]"}";`);
  L(`  FONT = NAME: "${font[0]}", SIZE: ${font[1]}, BOLD: ${font[2]};`);
  L(`  HEADERTEMPLATE = "${header}";`);
  L(`  TOOLTIPDELAY = ${w.tooltipDelay ?? d.tooltipDelay ?? -1};`);
  if (w.text) L(`  TEXT = "${w.text}";`);
  L(`  TEXTCOLOR = ENABLED: ${rgba(text.enabled)}, ENABLEDBORDER: ${rgba(text.enabledBorder)},`);
  L(`              DISABLED: ${rgba(text.disabled)}, DISABLEDBORDER: ${rgba(text.disabledBorder)},`);
  L(`              HILITE: ${rgba(text.hilite)}, HILITEBORDER: ${rgba(text.hiliteBorder)};`);
  if (w.type === "STATICTEXT") L(`  STATICTEXTDATA = CENTERED: ${w.staticText?.centered === false ? 0 : 1};`);
  if (w.type === "ENTRYFIELD") L(`  TEXTENTRYDATA = MAXLEN: ${w.entry?.maxLen ?? 64}, SECRETTEXT: 0, NUMERICALONLY: 0, ALPHANUMERICALONLY: 0, ASCIIONLY: 0;`);
  for (const line of drawData("ENABLEDDRAWDATA", colors, "enabled", w.images?.enabled).split("\n")) L(line);
  for (const line of drawData("DISABLEDDRAWDATA", colors, "disabled", w.images?.disabled).split("\n")) L(line);
  for (const line of drawData("HILITEDRAWDATA", colors, "hilite", w.images?.hilite).split("\n")) L(line);
  if (w.children && w.children.length) {
    L("  CHILD");
    for (const c of w.children) emitWindow(c, spec, out, indent + "  ");
    L("  ENDALLCHILDREN");
  }
  L("END");
}

export function buildWnd(spec: LayoutSpec): string {
  const out: string[] = [];
  out.push(`FILE_VERSION = ${spec.version ?? 2};`);
  out.push("STARTLAYOUTBLOCK");
  // No quotes here: parseInit/parseUpdate/parseShutdown take the raw token
  // (GameWindowManagerScript.cpp), unlike the window callbacks below.
  out.push(`  LAYOUTINIT = ${spec.layout?.init ?? "[None]"};`);
  out.push(`  LAYOUTUPDATE = ${spec.layout?.update ?? "[None]"};`);
  out.push(`  LAYOUTSHUTDOWN = ${spec.layout?.shutdown ?? "[None]"};`);
  out.push("ENDLAYOUTBLOCK");
  for (const w of spec.windows) emitWindow(w, spec, out, "");
  out.push("");
  return out.join("\r\n");
}

/** Collect every decorated window name in a spec (for cross-checking against engine code). */
export function listNames(spec: LayoutSpec): string[] {
  const names: string[] = [];
  const walk = (w: WindowSpec) => { names.push(w.name.includes(":") ? w.name : `${spec.file}:${w.name}`); w.children?.forEach(walk); };
  spec.windows.forEach(walk);
  return names;
}

function main() {
  const [cmd, specPath, outPath] = process.argv.slice(2);
  if (cmd === "build" && specPath && outPath) {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as LayoutSpec;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buildWnd(spec));
    console.log(`${outPath}: ${listNames(spec).length} windows`);
  } else if (cmd === "names" && specPath) {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as LayoutSpec;
    console.log(listNames(spec).join("\n"));
  } else {
    console.error("usage: wnd.ts build <spec.json> <out.wnd> | names <spec.json>");
    process.exit(2);
  }
}

if (process.argv[1] && /wnd\.ts$/.test(process.argv[1])) main();
