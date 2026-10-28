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
  /** SCROLLLISTBOX: LISTBOXDATA (length = max rows kept; columns > 1 needs columnWidths in percent). */
  listbox?: { length?: number; autoScroll?: boolean; autoPurge?: boolean; scrollBar?: boolean; multiSelect?: boolean; columns?: number; columnWidths?: number[]; forceSelect?: boolean };
  /** COMBOBOX: COMBOBOXDATA (maxDisplay = rows shown when dropped down). */
  combo?: { editable?: boolean; maxChars?: number; maxDisplay?: number; asciiOnly?: boolean; lettersAndNumbers?: boolean };
  /** HORZSLIDER / VERTSLIDER: SLIDERDATA. */
  slider?: { min?: number; max?: number };
  /** RADIOBUTTON: RADIOBUTTONDATA group id. */
  radio?: { group?: number };
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

const THUMB_COLORS: Required<Colors> = {
  enabled: [190, 160, 80, 255], enabledBorder: [255, 230, 150, 255],
  disabled: [80, 80, 80, 255], disabledBorder: [110, 110, 110, 255],
  hilite: [240, 200, 100, 255], hiliteBorder: [255, 255, 200, 255],
};
const rgba = (c: RGBA) => c.join(" ");

/** Per-slot overrides of draw-data entries 1..8 (entry 0 is the window itself). */
type Slots = Record<number, { color: RGBA; border: RGBA }>;

/**
 * CHECKBOX slots (GadgetCheckBox.h): 1 = unchecked box, 2 = checked box. The colour draws the
 * "x", the border the box. Unchecked gets the background colour, so its "x" is invisible —
 * with one colour in every slot a checked box looked exactly like an unchecked one.
 */
function checkboxSlots(c: Required<Colors>, state: "enabled" | "disabled" | "hilite"): Slots {
  const bg = c[state];
  const box: RGBA = state === "disabled" ? [110, 110, 110, 255] : [230, 230, 230, 255];
  const x: RGBA = state === "disabled" ? [140, 140, 140, 255] : [255, 214, 90, 255];
  return { 1: { color: bg, border: box }, 2: { color: x, border: box } };
}

function drawData(label: string, c: Required<Colors>, state: "enabled" | "disabled" | "hilite", image?: string, slots: Slots = {}): string {
  const color = c[state];
  const border = c[`${state}Border` as keyof Colors] as RGBA;
  const entry = (img: string, i: number) => `IMAGE: ${img}, COLOR: ${rgba(slots[i]?.color ?? color)}, BORDERCOLOR: ${rgba(slots[i]?.border ?? border)}`;
  const entries = Array.from({ length: 9 }, (_, i) => entry(i === 0 && image ? image : "NoImage", i));
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
  const b = (v: boolean | undefined, dflt: boolean) => ((v ?? dflt) ? 1 : 0);
  if (w.type === "SCROLLLISTBOX") {
    const lb = w.listbox ?? {};
    const columns = lb.columns ?? 1;
    const widths = columns > 1 ? (lb.columnWidths ?? Array.from({ length: columns }, () => Math.floor(100 / columns))).map((p) => `, COLUMNSWIDTH%: ${p}`).join("") : "";
    // SCROLLIFATEND is left out: the parser compares the token "SCROLLIFATEND:" (colon included) with
    // "ScrollIfAtEnd", never matches, and would read the whole block one field off.
    L(`  LISTBOXDATA = LENGTH: ${lb.length ?? 100}, AUTOSCROLL: ${b(lb.autoScroll, false)}, AUTOPURGE: ${b(lb.autoPurge, false)}, SCROLLBAR: ${b(lb.scrollBar, true)}, MULTISELECT: ${b(lb.multiSelect, false)}, COLUMNS: ${columns}${widths}, FORCESELECT: ${b(lb.forceSelect, false)};`);
  }
  if (w.type === "COMBOBOX") {
    const cb = w.combo ?? {};
    L(`  COMBOBOXDATA = ISEDITABLE: ${b(cb.editable, false)}, MAXCHARS: ${cb.maxChars ?? 16}, MAXDISPLAY: ${cb.maxDisplay ?? 8}, ASCIIONLY: ${b(cb.asciiOnly, false)}, LETTERSANDNUMBERS: ${b(cb.lettersAndNumbers, false)};`);
  }
  if (w.type === "HORZSLIDER" || w.type === "VERTSLIDER") L(`  SLIDERDATA = MINVALUE: ${w.slider?.min ?? 0}, MAXVALUE: ${w.slider?.max ?? 100};`);
  if (w.type === "RADIOBUTTON") L(`  RADIOBUTTONDATA = GROUP: ${w.radio?.group ?? 1};`);
  // Sliders, and the scroll bars of list/combo boxes, take their thumb's look from these blocks
  // (GameWindowManagerScript: enabledSliderThumbDrawData etc., copied into the thumb child on
  // creation). Without them the thumb has no colour and the slider shows no handle at all.
  // The other parts of list and combo boxes work the same way: scroll buttons and the scroll
  // track (LISTBOX*), the drop-down button, edit field and list of a combo box (COMBOBOX*). Unset,
  // they keep whatever the previous window in the file left in those globals (zero at first),
  // which left the scroll buttons of a combo list invisible.
  const block = (prefix: string, c: Required<Colors>) => {
    for (const st of ["enabled", "disabled", "hilite"] as const) {
      const name = prefix.replace("%", st.toUpperCase());
      for (const line of drawData(name, c, st).split("\n")) L(line);
    }
  };
  if (["HORZSLIDER", "VERTSLIDER", "SCROLLLISTBOX", "COMBOBOX"].includes(w.type)) block("SLIDERTHUMB%DRAWDATA", THUMB_COLORS);
  if (["SCROLLLISTBOX", "COMBOBOX"].includes(w.type)) {
    block("LISTBOX%UPBUTTONDRAWDATA", THUMB_COLORS);
    block("LISTBOX%DOWNBUTTONDRAWDATA", THUMB_COLORS);
    block("LISTBOX%SLIDERDRAWDATA", colors);
  }
  if (w.type === "COMBOBOX") {
    block("COMBOBOXDROPDOWNBUTTON%DRAWDATA", THUMB_COLORS);
    block("COMBOBOXEDITBOX%DRAWDATA", colors);
    block("COMBOBOXLISTBOX%DRAWDATA", colors);
  }
  const slots = (st: "enabled" | "disabled" | "hilite") => (w.type === "CHECKBOX" ? checkboxSlots(colors, st) : {});
  for (const line of drawData("ENABLEDDRAWDATA", colors, "enabled", w.images?.enabled, slots("enabled")).split("\n")) L(line);
  for (const line of drawData("DISABLEDDRAWDATA", colors, "disabled", w.images?.disabled, slots("disabled")).split("\n")) L(line);
  for (const line of drawData("HILITEDRAWDATA", colors, "hilite", w.images?.hilite, slots("hilite")).split("\n")) L(line);
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
