# assets-free — boot the engine without a single EA file

Zero Hour's `.big` archives are copyrighted and cannot ship with the web port.
This directory holds everything needed to get the engine from "wasm loaded"
to a live, clickable main menu **without them**, so that

- CI can boot the real engine on every push (not just compile it), and
- the free asset set (phase 5 of the plan) has a working skeleton to grow on.

## What is in the set

| Source | Files | Why |
|---|---|---|
| [TheSuperHackers/GeneralsGamePatch](https://github.com/TheSuperHackers/GeneralsGamePatch) (pinned commit in `build-free-assets.ts`) | `Data/INI/**` (52 files + `Object/`, `MappedImages/`, `Default/`), `generals.str` | The community patch keeps the full game-data INI set and the string table under GPL-3 (see their `LICENSE.txt` / EA mod terms in `TERMS.txt`). Our build converts their multi-language `generals.str` into the `Data/English/generals.csf` the engine actually loads. |
| `overlay/Data/English/Language.ini` | ours | Language/font block. The web port rasterises fonts with HTML5 Canvas, so the family name is all that matters. |
| `overlay/Data/English/HeaderTemplate.ini` | ours | Text styles (`Title`, `Subtitle`, `Button`, `Label`, `Small`) referenced by our `.wnd` layouts. |
| `overlay/Data/English/CommandMap.ini` | ours | Empty per-language hotkey override (optional, silences an INI ERROR). |
| `overlay/Data/INI/MappedImages/HandCreated/FreeAssets.ini` + `tools/asset-pipeline/tga.ts` | ours | Placeholder button plates and a "logo" that is really a colour-order probe (red / green / blue stripes): `check-menu-shot.py` reads the stripes back from the screenshot, so a channel-order bug in the texture path (as the WebGL2 no-swizzle one was) fails CI. |
| `maps/gxtest.map.json` + `tools/asset-pipeline/map.ts` | ours | A 64×64 flat map (USA human player vs. a China rival, start waypoints, afternoon lighting) written straight into the engine's DataChunk `.map` format — no WorldBuilder involved. `?args=-file+Maps/gxtest.map` launches it at boot. |
| `overlay/Data/INI/Default/GameData.ini` | ours | `ShroudOn = No` (plus the corpus `MapName` line): the free map carries no vision-giving objects yet, so with the shroud on the whole tactical view is unexplored, i.e. black. Goes away once the map has units. |
| `Art/Textures/TSCloudMed.tga`, `TSNoiseUrb.tga` | ours | The terrain's cloud and "lightmap" noise maps. `TerrainShader2Stage` multiplies the frame by them (`DESTCOLOR * ZERO`), so when they are missing the terrain goes black; the free set generates bright, soft versions. |
| `overlay/Data/INI/Default/Terrain.ini` + `Art/Terrain/gxgrass.tga` | ours | The map's one terrain type. `Default\Terrain.ini` is loaded before the corpus `Terrain.ini`, so it is where the free set adds types without replacing the corpus file; the texture is a procedural 2×2-tile sheet. |
| `windows/ShellGameLoadScreen.wnd.json`, `windows/BlankWindow.wnd.json` | ours | Load screen (`ProgressLoad`, `StaticTextLegal`) and the black backdrop `prepareNewGame` puts behind a loading game. |
| `windows/ControlBar.wnd.json`, `GeneralsExpPoints.wnd.json`, `GenPowersShortcutBar{US,China,GLA}.wnd.json` (from `tools/asset-pipeline/gen-hud-layouts.ts`) | ours | The in-game HUD windows. Every window `ControlBar*.cpp` looks up exists (92 in `ControlBar.wnd`, numbered ones in the counts the code iterates). The windows are transparent holes and buttons; the art is the scheme's (below). These layouts live in `Window\` (spec `"dir": ""`), not `Window\Menus\`. |
| `tools/asset-pipeline/hud-skin.ts` → `Art/Textures/gxhud_{usa,china,gla}.tga`, `MappedImages/HandCreated/GxHud*.ini`, `Data/INI/ControlBarScheme.ini` | ours | The control-bar skin: one procedural 512×512 atlas per faction (bar body, right-HUD panel with emblem, side buttons with icons in 4 states, general/min-max/attack buttons, queue and cameo plates, power points, exp bar) plus our own `ControlBarScheme.ini` (replaces the corpus file, which references retail art) that positions the money display, power bar and side buttons (`ControlBarSchemeManager` moves those windows at runtime) and draws the bar through `W3DCommandBarBackgroundDraw`. `HUD` in `hud-skin.ts` is the single source of geometry for the skin and the layouts. |
| `tools/asset-pipeline/mapped-images.ts` → `Art/Textures/*.tga` (125 atlases, 6.5 MB RLE) | ours | Labelled placeholders for every texture the corpus `MappedImages/**` reference (~1 400 images: unit cameos, icons, menu art): each image's rectangle is a tinted bevelled tile with its `MappedImage` name in a pixel font. Replace a texture with real art one file at a time. |
| `windows/MainMenu.wnd.json` | ours | Main menu layout, expanded to `.wnd` by `tools/asset-pipeline/wnd.ts`. Mirrors the window hierarchy `MainMenu.cpp` and `WindowTransitions.ini` expect (`MapBorder2` = main panel, `MapBorder` = single-player, `MapBorder1` = multiplayer, `MapBorder3` = replays, `MapBorder4` = difficulty, faction windows, `Logo`, `MainMenuRuler`, ...). All 57 window names the code looks up exist, most as hidden placeholders. |

Nothing here is derived from retail `.big` contents; the layouts and INI stubs
are written from the engine source.

## Build

```bash
node --experimental-strip-types tools/asset-pipeline/build-free-assets.ts out/
# -> out/assets/{INIZH,WindowZH,TexturesZH,MapsZH}.big   (the patch corpus is cloned into out/.cache)
```

Put `out/assets/` next to `GeneralsZH.html` (the engine fetches `assets/INIZH.big`
etc. over HTTP Range), run `python3 serve.py`, open the page: the engine boots,
reports `Ready`, and after the first click/key shows the main menu.

Headless check (what CI runs): Begin, Space, SOLO PLAY → BACK → EXIT GAME, then the
screenshot (lit menu, colour probe) and the `?diag=1` traces are checked. A second run
launches the map with `?args=-file+Maps/gxtest.map`, expects `GAMELOGIC: startNewGame`
followed by `TICK-DIAG ... inGame=1`, and `check-map-shot.py` requires the centre of the
tactical view to be grass-green (the first 3D content the WebGL2 shim renders).

```bash
npx playwright install chromium
SMOKE_KEYS=Space SMOKE_CLICKS="512,274;512,504;512,504" \
SMOKE_EXPECT="GBM_SELECTED 'MainMenu.wnd:ButtonSinglePlayer';Clearing dontAllowTransitions" \
node tools/asset-pipeline/smoke.js "http://localhost:8888/GeneralsZH.html?diag=1" 120000 shot.png 8000 --begin
python3 tools/asset-pipeline/check-menu-shot.py shot.png
```

## How the engine gets there (for the next person)

Boot order and what each step needs, as discovered by iterating on the
`INI ERROR:` lines the web build prints before an `INIError`:

1. `TheGameText` — `Data\generals.str` (text) or `Data\English\generals.csf` (binary). Without one, every `DisplayName = LABEL` in the INI throws at the first `parseAndTranslateLabel`.
2. `Data\INI\Default\<X>` + `Data\INI\<X>` for ~40 subsystems (`GameEngine.cpp`), each via `loadFileDirectory` which requires the file *or* a directory of `.ini` files to exist.
3. `Data\<Language>\Language.ini` (`GlobalLanguage.cpp`) and `Data\<Language>\HeaderTemplate.ini`.
4. `Window\Menus\MainMenu.wnd` via `TheShell`. Two format traps: the layout block names are **unquoted** (`LAYOUTINIT = MainMenuInit;` — quoted names silently bind no callbacks, so the menu draws but never updates), and container panels need `SYSTEMCALLBACK = "PassSelectedButtonsToParentSystem"` or button presses never reach the layout's system callback. Missing → black screen, no crash. On first run the menu stays hidden until a key press or a >20 px mouse move (`MainMenu.cpp`, "press any key" after the logo movie), then `MapBorder2` is shown and the `MainMenuDefaultMenu` transition runs.

## Next

- `OptionsMenu.wnd`, `SkirmishGameOptionsMenu.wnd`, `MapSelectMenu.wnd`, ... — each menu the main menu can open (`MessageBox.wnd` / `QuitMessageBox.wnd` are done).
- HUD polish: cameo images for command buttons (`W3DCommandBarGridDraw`), `W3DPowerDraw` needs `PowerPoint{Y,R,G}` images, a drawn control-bar skin instead of the flat atlases.
- A handful of W3D models (command center, dozer, one infantry) so the map has something on it (see `inventory.ts`).
