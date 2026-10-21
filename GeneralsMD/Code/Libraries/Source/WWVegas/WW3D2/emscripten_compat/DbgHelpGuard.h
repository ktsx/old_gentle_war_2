// GeneralsX @merge 2026-10-21 — Emscripten stand-in for Dependencies/DbgHelp/DbgHelpGuard.h.
// dbghelp.dll does not exist on the web; the guard is a no-op.
#pragma once
class DbgHelpGuard
{
public:
	DbgHelpGuard() {}
	~DbgHelpGuard() {}
	void activate() {}
	void deactivate() {}
};
