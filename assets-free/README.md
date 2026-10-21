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
| `overlay/Data/INI/Default/*.ini` | ours | Empty stubs for the `Default\<X>.ini` files the engine insists on opening (`loadFileDirectory` throws when neither file nor directory exists); the retail defaults live in the main `<X>.ini`. |
| `overlay/Data/INI/MappedImages/HandCreated/FreeAssets.ini` + `tools/asset-pipeline/tga.ts` | ours | Placeholder button plates and a "logo" that is really a colour-order probe (red / green / blue stripes): `check-menu-shot.py` reads the stripes back from the screenshot, so a channel-order bug in the texture path (as the WebGL2 no-swizzle one was) fails CI. |
| `windows/MainMenu.wnd.json` | ours | Main menu layout, expanded to `.wnd` by `tools/asset-pipeline/wnd.ts`. Mirrors the window hierarchy `MainMenu.cpp` and `WindowTransitions.ini` expect (`MapBorder2` = main panel, `MapBorder` = single-player, `MapBorder1` = multiplayer, `MapBorder3` = replays, `MapBorder4` = difficulty, faction windows, `Logo`, `MainMenuRuler`, ...). All 57 window names the code looks up exist, most as hidden placeholders. |

Nothing here is derived from retail `.big` contents; the layouts and INI stubs
are written from the engine source.

## Build

```bash
node --experimental-strip-types tools/asset-pipeline/build-free-assets.ts out/
# -> out/assets/{INIZH,WindowZH,TexturesZH}.big   (the patch corpus is cloned into out/.cache)
```

Put `out/assets/` next to `GeneralsZH.html` (the engine fetches `assets/INIZH.big`
etc. over HTTP Range), run `python3 serve.py`, open the page: the engine boots,
reports `Ready`, and after the first click/key shows the main menu.

Headless check (what CI runs):

```bash
npx playwright install chromium
SMOKE_KEYS=Space node tools/asset-pipeline/smoke.js http://localhost:8888/GeneralsZH.html 60000 shot.png 8000 --begin
```

## How the engine gets there (for the next person)

Boot order and what each step needs, as discovered by iterating on the
`INI ERROR:` lines the web build prints before an `INIError`:

1. `TheGameText` — `Data\generals.str` (text) or `Data\English\generals.csf` (binary). Without one, every `DisplayName = LABEL` in the INI throws at the first `parseAndTranslateLabel`.
2. `Data\INI\Default\<X>` + `Data\INI\<X>` for ~40 subsystems (`GameEngine.cpp`), each via `loadFileDirectory` which requires the file *or* a directory of `.ini` files to exist.
3. `Data\<Language>\Language.ini` (`GlobalLanguage.cpp`) and `Data\<Language>\HeaderTemplate.ini`.
4. `Window\Menus\MainMenu.wnd` via `TheShell`. Missing → black screen, no crash. On first run the menu stays hidden until a key press or a >20 px mouse move (`MainMenu.cpp`, "press any key" after the logo movie), then `MapBorder2` is shown and the `MainMenuDefaultMenu` transition runs.

## Next

- `Menus/QuitMessageBox.wnd`, `OptionsMenu.wnd`, `SkirmishGameOptionsMenu.wnd`, ... — each menu the main menu can open.
- One map + a handful of W3D models to reach a running skirmish (see `inventory.ts`).
