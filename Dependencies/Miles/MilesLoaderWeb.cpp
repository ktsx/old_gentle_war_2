// GeneralsX @merge 2026-10-21 — Emscripten: there is no mss32.dll to load.
// The AIL_* surface declared in mss/mss.h is implemented by the Web Audio
// bridge (Core/Libraries/Source/WebAudioBridge/web_audio_bridge.cpp), which is
// linked into this same `milesloader` target, so "loading" always succeeds.
#include "MilesLoader.h"

bool MilesLoader::isLoaded() { return true; }
bool MilesLoader::isFailed() { return false; }
unsigned long MilesLoader::getLastError() { return 0; }
bool MilesLoader::load() { return true; }
void MilesLoader::unload() {}
