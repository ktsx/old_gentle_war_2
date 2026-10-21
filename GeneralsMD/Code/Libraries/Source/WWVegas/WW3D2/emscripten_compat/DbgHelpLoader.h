// GeneralsX @merge 2026-10-21 — Emscripten stand-in for Dependencies/DbgHelp/DbgHelpLoader.h.
// Upstream builds the dbghelp runtime loader on Windows only (root CMakeLists.txt
// defines an empty `dbghelploader` INTERFACE target elsewhere); the only web
// translation unit that includes this header (StackDump.cpp) keeps its DbgHelp
// use under _WIN32, so an empty header is all that is needed.
#pragma once
