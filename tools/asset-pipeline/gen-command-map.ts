#!/usr/bin/env node --experimental-strip-types
/**
 * gen-command-map.ts — write assets-free/overlay/Data/English/CommandMap.ini, the in-game hotkeys.
 *
 * The corpus' Data/INI/CommandMap.ini is a 4-line stub and the real bindings live in the
 * localized Data/<Language>/CommandMap.ini — EA data we do not ship. Without it the free set had
 * no hotkeys in a match at all: no ESC menu, no control groups, no Stop/Scatter, no Ctrl
 * force-fire. This writes the usual Zero Hour layout (MetaEvent.cpp names, MetaEvent.h key and
 * modifier names):
 *
 *   ESC game menu · Enter chat (Shift+Enter allies) · ` diplomacy · F9 hide control bar · F12 screenshot
 *   Ctrl+B beacon, Del removes it (network games)
 *   0-9 select group, Ctrl+n create, Shift+n add, Alt+n jump to group
 *   Q select all, W all aircraft, E matching units, Tab / Shift+Tab next/prev unit, I idle worker
 *   S stop, X scatter, D deploy, Ctrl+F formation, Ctrl+R hero
 *   held Ctrl force attack, held Alt waypoints, held Shift prefer selection, Ctrl+Alt force move
 *   H command centre, Space last radar event, Backspace camera reset, F1-F8 views (Ctrl saves)
 *
 * In a browser some combinations belong to the browser first (Ctrl+number switches tabs in most
 * of them, Ctrl+W closes the tab); web_shell.html only forwards what the page receives.
 *
 * Modifier-only commands use Key = KEY_NONE: MetaEventTranslator fires the DOWN record when the
 * modifier goes down and the UP record when it is released (onKeyModStateRemoved).
 *
 * Each command also gets a DisplayName and a Description (labels GX:Cmd_<META> /
 * GX:CmdDesc_<META>, written to assets-free/command-strings.str) for the hotkey reference,
 * OPTIONS > KEYBOARD (KeyboardOptionsMenu.wnd). The release half of a held command (END_*) has
 * no name and stays out of that list.
 *
 * Usage: node --experimental-strip-types tools/asset-pipeline/gen-command-map.ts
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets-free");
const out = join(root, "overlay", "Data", "English", "CommandMap.ini");
const strOut = join(root, "command-strings.str");    // merged into generals.csf by build-free-assets.ts

type Rec = { meta: string; key: string; mod?: string; transition?: "DOWN" | "UP"; usable?: string; category: string; name?: string; desc?: string };
const recs: Rec[] = [];
const add = (meta: string, key: string, category: string, mod = "NONE", transition: "DOWN" | "UP" = "DOWN", usable = "GAME") =>
  recs.push({ meta, key, mod, transition, usable, category });
/** name + description of the command just added */
const label = (name: string, desc: string) => { const r = recs[recs.length - 1]; r.name = name; r.desc = desc; };

// interface
add("OPTIONS", "KEY_ESC", "INTERFACE"); label("Game menu", "Opens the game menu: save, load, options, exit.");
// Chat and diplomacy open InGameChat.wnd / Diplomacy.wnd (gen-ingame-layouts.ts), which
// ShowInGameChat/ShowDiplomacy use without a null check — keep those layouts in the set.
add("CHAT_EVERYONE", "KEY_ENTER", "INTERFACE"); label("Chat with everyone", "Type a message to all players (network games).");
add("CHAT_ALLIES", "KEY_ENTER", "INTERFACE", "SHIFT"); label("Chat with allies", "Type a message to your allies only (network games).");
add("DIPLOMACY", "KEY_TICK", "INTERFACE"); label("Diplomacy", "Shows the players, their sides and teams, and the mission objectives.");
add("TOGGLE_CONTROL_BAR", "KEY_F9", "INTERFACE"); label("Hide control bar", "Hides or shows the command bar at the bottom of the screen.");
add("PLACE_BEACON", "KEY_B", "INTERFACE", "CTRL"); label("Place beacon", "Marks a spot on the map for your allies (network games).");       // network games only (CommandXlat)
add("DELETE_BEACON", "KEY_DEL", "INTERFACE"); label("Remove beacon", "Removes the selected beacon.");
add("TAKE_SCREENSHOT_PNG", "KEY_F12", "MISC", "NONE", "DOWN", "SHELL GAME OBSERVER"); label("Screenshot", "Saves a picture of the screen.");

// control groups
for (let n = 0; n <= 9; n++) {
  add(`CREATE_TEAM${n}`, `KEY_${n}`, "TEAM", "CTRL"); label(`Create group ${n}`, `Makes the selected units control group ${n}.`);
  add(`SELECT_TEAM${n}`, `KEY_${n}`, "TEAM"); label(`Select group ${n}`, `Selects control group ${n}; press twice to centre the camera on it.`);
  add(`ADD_TEAM${n}`, `KEY_${n}`, "TEAM", "SHIFT"); label(`Add to group ${n}`, `Adds the selected units to control group ${n}.`);
  add(`VIEW_TEAM${n}`, `KEY_${n}`, "TEAM", "ALT"); label(`View group ${n}`, `Centres the camera on control group ${n}.`);
}

// selection
add("SELECT_ALL", "KEY_Q", "SELECTION"); label("Select all units", "Selects all of your combat units on the map.");
add("SELECT_ALL_AIRCRAFT", "KEY_W", "SELECTION"); label("Select all aircraft", "Selects all of your aircraft.");
add("SELECT_MATCHING_UNITS", "KEY_E", "SELECTION"); label("Select matching units", "Selects all on-screen units of the same type as the selection.");
add("SELECT_NEXT_UNIT", "KEY_TAB", "SELECTION"); label("Next unit", "Selects your next unit and centres the camera on it.");
add("SELECT_PREV_UNIT", "KEY_TAB", "SELECTION", "SHIFT"); label("Previous unit", "Selects your previous unit and centres the camera on it.");
add("SELECT_NEXT_IDLE_WORKER", "KEY_I", "SELECTION"); label("Next idle worker", "Selects a worker or dozer that has nothing to do.");
add("SELECT_HERO", "KEY_R", "SELECTION", "CTRL"); label("Select hero", "Selects your hero unit.");

// orders
add("STOP", "KEY_S", "CONTROL"); label("Stop", "The selected units stop what they are doing.");
add("SCATTER", "KEY_X", "CONTROL"); label("Scatter", "The selected units spread out.");
add("DEPLOY", "KEY_D", "CONTROL"); label("Deploy", "Deploys or packs up the selected units.");
add("CREATE_FORMATION", "KEY_F", "CONTROL", "CTRL"); label("Formation", "The selected units keep their positions relative to each other when they move.");
add("BEGIN_FORCEATTACK", "KEY_NONE", "CONTROL", "CTRL", "DOWN"); label("Force attack (hold)", "While held, a click attacks the target or the ground, even a friendly one.");
add("END_FORCEATTACK", "KEY_NONE", "CONTROL", "CTRL", "UP");
add("BEGIN_WAYPOINTS", "KEY_NONE", "CONTROL", "ALT", "DOWN"); label("Waypoints (hold)", "While held, each click adds a waypoint to the move order.");
add("END_WAYPOINTS", "KEY_NONE", "CONTROL", "ALT", "UP");
add("BEGIN_PREFER_SELECTION", "KEY_NONE", "CONTROL", "SHIFT", "DOWN"); label("Add to selection (hold)", "While held, clicked or boxed units are added to the selection.");
add("END_PREFER_SELECTION", "KEY_NONE", "CONTROL", "SHIFT", "UP");
add("BEGIN_FORCEMOVE", "KEY_NONE", "CONTROL", "CTRL_ALT", "DOWN"); label("Force move (hold)", "While held, units move to the clicked spot without attacking on the way.");
add("END_FORCEMOVE", "KEY_NONE", "CONTROL", "CTRL_ALT", "UP");

// camera
add("VIEW_COMMAND_CENTER", "KEY_H", "INFORMATION"); label("View command center", "Centres the camera on your command center.");
add("VIEW_LAST_RADAR_EVENT", "KEY_SPACE", "INFORMATION"); label("View last radar event", "Centres the camera on the latest event shown on the radar.");
add("CAMERA_RESET", "KEY_BACKSPACE", "INFORMATION"); label("Reset camera", "Returns the camera to its default angle and height.");
for (let n = 1; n <= 8; n++) {
  add(`SAVE_VIEW${n}`, `KEY_F${n}`, "INFORMATION", "CTRL"); label(`Save camera view ${n}`, `Remembers the current camera position as view ${n}.`);
  add(`VIEW_VIEW${n}`, `KEY_F${n}`, "INFORMATION"); label(`Go to camera view ${n}`, `Moves the camera to saved view ${n}.`);
}

const header = `; CommandMap.ini - in-game hotkeys of the free asset set.
; Generated by tools/asset-pipeline/gen-command-map.ts; edit that file, not this one.
`;
const body = recs.map((r) =>
  `CommandMap ${r.meta}\n  Key = ${r.key}\n  Transition = ${r.transition}\n  Modifiers = ${r.mod}\n  UseableIn = ${r.usable}\n  Category = ${r.category}\n` +
  (r.name ? `  DisplayName = GX:Cmd_${r.meta}\n  Description = GX:CmdDesc_${r.meta}\n` : "") + `End\n`).join("\n");
writeFileSync(out, header + "\n" + body);
console.log(`wrote ${out}: ${recs.length} commands`);

const missing = recs.filter((r) => !r.name && !r.meta.startsWith("END_")).map((r) => r.meta);
if (missing.length) throw new Error(`commands without a name: ${missing.join(", ")}`);
const q = (t: string) => t.replace(/"/g, "'");
const strings = recs.filter((r) => r.name).map((r) =>
  `GX:Cmd_${r.meta}\nUS: "${q(r.name!)}"\nEND\n\nGX:CmdDesc_${r.meta}\nUS: "${q(r.desc!)}"\nEND\n`).join("\n");
writeFileSync(strOut, `// Hotkey names and descriptions — generated by tools/asset-pipeline/gen-command-map.ts.\n\n${strings}`);
console.log(`wrote ${strOut}`);
