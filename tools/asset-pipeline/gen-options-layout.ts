#!/usr/bin/env node --experimental-strip-types
/**
 * gen-options-layout.ts — write assets-free/windows/OptionsMenu.wnd.json, the OPTIONS screen, and
 * QuitMenu.wnd.json / QuitNoSave.wnd.json, the in-game menu that leads to it (see quitLayout below).
 *
 * The OPTIONS screen
 * (OptionsMenu.cpp; opened from the main menu and the in-game quit menu through
 * Shell::getOptionsLayout → "Menus/OptionsMenu.wnd").
 *
 * Every window OptionsMenuInit / saveOptions / OptionsMenuSystem looks up exists — several are
 * dereferenced without a null check (the LAN IP combo, the firewall button, the advanced panel,
 * every slider and checkbox through the Gadget* calls):
 *
 *   Display   ComboBoxResolution, ComboBoxDetail, ComboBoxAntiAliasing, SliderGamma
 *   Audio     SliderMusicVolume, SliderSFXVolume, SliderVoiceVolume
 *   Gameplay  SliderScrollSpeed, CheckAlternateMouse, Retaliation, CheckDoubleClickAttackMove,
 *             CheckBoxDrawAnchor, CheckBoxMoveAnchor, CheckBoxSaveCamera, CheckBoxUseCamera,
 *             CheckLanguageFilter
 *   Advanced  WinAdvancedDisplayOptions (shown when Detail = Custom): LowResSlider (0..2),
 *             Check3DShadows, Check2DShadows, CheckCloudShadows, CheckGroundLighting,
 *             CheckSmoothWater, CheckExtraAnimations, CheckNoDynamicLOD, CheckHeatEffects,
 *             CheckUnlockFPS, CheckBehindBuilding, CheckShowProps, ParticleCapSlider,
 *             ButtonAdvanceAccept, ButtonAdvanceBack
 *   Network   ComboBoxIP, ButtonFirewallRefresh — present but hidden: the web build has no LAN
 *             or online play yet (ComboBoxOnlineIP / TextEntryFirewallPortOverride are optional
 *             in the code and left out)
 *   Bottom    LabelVersion, ButtonDefaults, ButtonBack, ButtonAccept
 *
 * ButtonKeyboardOptions is left out until KeyboardOptionsMenu.wnd exists (the button pushes it).
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-options-layout.ts
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
const ADV = { enabled: [20, 24, 32, 250], enabledBorder: [200, 170, 90, 255] } as const;
const GADGET = { enabled: [34, 38, 48, 255], enabledBorder: [110, 120, 140, 255], hilite: [60, 80, 120, 255], hiliteBorder: [190, 205, 230, 255], disabled: [24, 24, 28, 255], disabledBorder: [60, 60, 66, 255] } as const;

const combo = (name: string, rect: Rect) =>
  win(name, "COMBOBOX", rect, { headerTemplate: "Small", colors: GADGET, combo: { maxDisplay: 6, maxChars: 24 } });
/**
 * W3DGadgetCheckBoxDraw puts the box at x + width/16 (size height/3) and the text at x + height,
 * so a wide checkbox draws its box under the text: keep width ≤ 9 × height (box ends before the
 * text starts). The row is clickable over that width only.
 */
const check = (name: string, rect: Rect, text: string) => {
  const h = 26;
  return win(name, "CHECKBOX", [rect[0], rect[1] - 2, Math.min(rect[2], 9 * h), h], { text, headerTemplate: "Small", colors: GADGET });
};
const slider = (name: string, rect: Rect, min: number, max: number) =>
  win(name, "HORZSLIDER", rect, { slider: { min, max }, colors: GADGET });

/** Children are written relative to their parent here; .wnd rects are absolute, so shift them. */
const place = (ws: WindowSpec[], dx: number, dy: number): WindowSpec[] =>
  ws.map((w) => {
    const [x, y] = w.rect;
    const rect: Rect = [x + dx, y + dy, w.rect[2], w.rect[3]];
    return { ...w, rect, ...(w.children ? { children: place(w.children, x + dx, y + dy) } : {}) };
  });

// 800x600 creation resolution; the panel sits centred.
const P: Rect = [60, 30, 680, 540];
const L = 24, R = 352, W = 304;          // column x (relative to the panel) and width
const row = (i: number, y0: number) => y0 + i * 30;

/** A label above-left and a control to its right, both in one 26-px row. */
const labelled = (lname: string, text: string, x: number, y: number, control: WindowSpec): WindowSpec[] => {
  const [, , cw, ch] = control.rect;
  control.rect = [x + W - cw, y, cw, ch];
  return [label(lname, [x, y + 3, W - cw - 8, 20], text), control];
};

const display: WindowSpec[] = [
  heading("StaticTextDisplay", [L, 64, W, 22], "GUI:DisplayOptions"),
  ...labelled("StaticTextResolution", "GUI:Resolution", L, row(0, 92), combo("ComboBoxResolution", [0, 0, 150, 24])),
  ...labelled("StaticTextDetail", "GUI:Detail", L, row(1, 92), combo("ComboBoxDetail", [0, 0, 150, 24])),
  ...labelled("StaticTextAntiAliasing", "GUI:AntiAliasing", L, row(2, 92), combo("ComboBoxAntiAliasing", [0, 0, 150, 24])),
  ...labelled("StaticTextGamma", "GUI:GammaAdjustment", L, row(3, 92), slider("SliderGamma", [0, 4, 150, 18], 0, 100)),
];
const audio: WindowSpec[] = [
  heading("StaticTextAudio", [L, 230, W, 22], "GUI:AudioOptions"),
  ...labelled("StaticTextMusic", "GUI:MusicVolume", L, row(0, 258), slider("SliderMusicVolume", [0, 4, 150, 18], 0, 100)),
  ...labelled("StaticTextSFX", "GUI:SFXVolume", L, row(1, 258), slider("SliderSFXVolume", [0, 4, 150, 18], 0, 100)),
  ...labelled("StaticTextVoice", "GUI:VoiceVolume", L, row(2, 258), slider("SliderVoiceVolume", [0, 4, 150, 18], 0, 100)),
];
const gameplay: WindowSpec[] = [
  heading("StaticTextGameplay", [R, 64, W, 22], "GX:Gameplay"),
  // ScrollFactor = slider / 100; the corpus GameData sets 2.0, so the range goes past 200
  ...labelled("StaticTextScrollSpeed", "GUI:ScrollSpeed", R, row(0, 92), slider("SliderScrollSpeed", [0, 4, 150, 18], 10, 300)),
  check("CheckAlternateMouse", [R, row(1, 92), W, 22], "GUI:AlternateMouse"),
  check("Retaliation", [R, row(2, 92), W, 22], "GUI:RetaliationTitle"),
  check("CheckDoubleClickAttackMove", [R, row(3, 92), W, 22], "GUI:DoubleClickAttackMove"),
  check("CheckBoxDrawAnchor", [R, row(4, 92), W, 22], "GUI:DrawScrollAnchor"),
  check("CheckBoxMoveAnchor", [R, row(5, 92), W, 22], "GUI:MoveScrollAnchor"),
  check("CheckBoxSaveCamera", [R, row(6, 92), W, 22], "GUI:SaveCamera"),
  check("CheckBoxUseCamera", [R, row(7, 92), W, 22], "GUI:UseCamera"),
  check("CheckLanguageFilter", [R, row(8, 92), W, 22], "GX:LanguageFilter"),
];
const network: WindowSpec[] = [
  hidden(combo("ComboBoxIP", [L, 380, 150, 24])),
  hidden(button("ButtonFirewallRefresh", [L + 160, 380, 140, 26], "GUI:FirewallRefresh")),
];
const bottom: WindowSpec[] = [
  label("LabelVersion", [L, 446, 420, 36], "", { font: ["Arial", 10, 0], textColor: { enabled: [140, 150, 170, 255], enabledBorder: [0, 0, 0, 255] } }),
  button("ButtonDefaults", [L, 492, 150, 32], "GUI:Defaults"),
  button("ButtonBack", [P[2] - 24 - 150 - 12 - 150, 492, 150, 32], "GUI:Back"),
  button("ButtonAccept", [P[2] - 24 - 150, 492, 150, 32], "GUI:Accept"),
];

// Detail = Custom opens this over the panel; OptionsMenuInit hides it.
const A: Rect = [90, 70, 500, 400];
const ac = (name: string, i: number, text: string) => check(name, [24 + (i % 2) * 230, 104 + Math.floor(i / 2) * 30, 222, 22], text);
const advanced = win("WinAdvancedDisplayOptions", "USER", A, {
  colors: ADV,
  children: [
    heading("StaticTextAdvanced", [24, 16, 452, 22], "GUI:AdvanceDisplayOptions"),
    label("StaticTextTextureRes", [24, 52, 200, 20], "GX:TextureResolution"),
    // TextureReduction = 2 - slider: right is full resolution
    slider("LowResSlider", [232, 54, 244, 18], 0, 2),
    label("StaticTextTextureLow", [232, 74, 80, 16], "GUI:TextureLow", { font: ["Arial", 10, 0] }),
    label("StaticTextTextureHigh", [396, 74, 80, 16], "GUI:TextureHigh", { font: ["Arial", 10, 0], staticText: { centered: false } }),
    ac("Check3DShadows", 0, "GUI:Shadows3D"),
    ac("Check2DShadows", 1, "GUI:Shadows2D"),
    ac("CheckCloudShadows", 2, "GUI:CloudShadows"),
    ac("CheckGroundLighting", 3, "GUI:GroundLighting"),
    ac("CheckSmoothWater", 4, "GUI:SmoothWater"),
    ac("CheckExtraAnimations", 5, "GUI:ExtraAnimations"),
    ac("CheckNoDynamicLOD", 6, "GUI:NoDynamicLOD"),
    ac("CheckHeatEffects", 7, "GUI:HeatEffects"),
    ac("CheckUnlockFPS", 8, "GUI:UnlockMaxFPS"),
    ac("CheckBehindBuilding", 9, "GUI:BehindBuilding"),
    ac("CheckShowProps", 10, "GUI:ShowProps"),
    label("StaticTextParticleCap", [24, 290, 200, 20], "GUI:ParticleCap"),
    slider("ParticleCapSlider", [232, 292, 244, 18], 100, 5000),
    label("StaticTextFewer", [232, 312, 120, 16], "GUI:LessParticlesFaster", { font: ["Arial", 10, 0] }),
    button("ButtonAdvanceBack", [500 - 24 - 140 - 12 - 140, 352, 140, 30], "GUI:Back"),
    button("ButtonAdvanceAccept", [500 - 24 - 140, 352, 140, 30], "GUI:Accept"),
  ],
});

const options: LayoutSpec = {
  file: "OptionsMenu.wnd",
  version: 2,
  layout: { init: "OptionsMenuInit", update: "OptionsMenuUpdate", shutdown: "OptionsMenuShutdown" },
  creationResolution: [800, 600],
  defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
  windows: [
    win("OptionsMenuParent", "USER", P, {
      system: "OptionsMenuSystem", input: "OptionsMenuInput", colors: PANEL,
      children: place([
        label("StaticTextTitle", [L, 18, 400, 30], "GUI:Options", { font: ["Arial", 20, 1], headerTemplate: "Title" }),
        // Siblings declared later draw on top, and an open combo box list hangs over the rows
        // below it — so the display rows go in bottom-up (their lists then cover the rows below).
        ...audio, ...gameplay, ...network, ...bottom, ...[...display].reverse(),
        advanced,                                         // last: drawn over the rest when shown
      ], P[0], P[1]),
    }),
  ],
};

// ---------------------------------------------------------------------------
// QuitMenu.wnd / QuitNoSave.wnd — the in-game menu (ESC). QuitMenu.cpp opens QuitMenu.wnd in
// single-player and skirmish games and QuitNoSave.wnd in network games and replays; the parent
// name QuitMenuParent and the buttons are what WindowTransitions.ini (QuitFull / QuitNoSave)
// animate. ButtonSaveLoad is left out: the code checks it for null, and PopupSaveLoad.wnd, which
// it would open, does not exist yet. Restart/Exit texts are set by the code per game type.
// ---------------------------------------------------------------------------
const quitLayout = (file: string): LayoutSpec => {
  const Q: Rect = [270, 150, 260, 268];
  const b = (name: string, i: number, text: string) => button(name, [20, 60 + i * 48, 220, 36], text);
  return {
    file,
    version: 2,
    creationResolution: [800, 600],
    defaults: { font: ["Arial", 12, 1], headerTemplate: "Label" },
    windows: [
      win("QuitMenuParent", "USER", Q, {
        system: "QuitMenuSystem", colors: PANEL,
        children: place([
          heading("StaticTextTitle", [20, 18, 220, 24], "GX:GameMenu"),
          b("ButtonReturn", 0, "GUI:ReturnToGame"),
          b("ButtonOptions", 1, "GUI:Options"),
          b("ButtonRestart", 2, "GUI:RestartMission"),
          b("ButtonExit", 3, "GUI:ExitMission"),
        ], Q[0], Q[1]),
      }),
    ],
  };
};

for (const spec of [options, quitLayout("QuitMenu.wnd"), quitLayout("QuitNoSave.wnd")]) {
  const path = join(outDir, spec.file + ".json");
  writeFileSync(path, JSON.stringify(spec, null, 1) + "\n");
  console.log(`wrote ${path}`);
}
