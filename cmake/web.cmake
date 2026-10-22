# ============================================================================
# GeneralsX Web Port — CMake Integration
#
# Drop-in replacement for cmake/dx8.cmake when building for Emscripten.
# Instead of fetching DXVK or DirectX SDK, this configures the OpenGL ES 3.0
# wrapper that targets WebGL 2.0.
#
# GeneralsX @feature WebPort 09/03/2026
# ============================================================================

# CMAKE_PROJECT_INCLUDE re-runs this file at every subproject's project() call
# (gamespy, Generals, GeneralsMD). The flags and targets below must only be
# created once, at the top level — guard against re-entry.
# GeneralsX @build WebPort 2026-07-06
if(GENERALSX_WEB_CMAKE_INCLUDED)
    return()
endif()
set(GENERALSX_WEB_CMAKE_INCLUDED TRUE)

message(STATUS "=== Configuring GeneralsX Web Port (Emscripten + WebGL 2.0) ===")

# ============================================================================
# 1. Emscripten Compiler Flags
# ============================================================================

# WebGL 2.0 = OpenGL ES 3.0 (compile-time). The matching -s link flags live
# with the rest of the z_generals link line (see note below).
add_compile_options(-sUSE_WEBGL2=1 -sFULL_ES3=1)

# Enable C++ exception catching so init failures surface as messages.
add_compile_options(-fexceptions -g)

# Precompiled headers must be byte-identical between builds for ccache to hit:
# by default clang records the mtime of every header in the PCH, and a fresh CI
# checkout has fresh mtimes, so every PCH user missed the cache. (ccache in CI:
# .github/workflows/web-build.yml.)
add_compile_options(-Xclang -fno-pch-timestamp)
add_link_options(-fexceptions -sDISABLE_EXCEPTION_CATCHING=0)

# ----------------------------------------------------------------------------
# All other link flags — heap size, WebGL, FETCH, ASYNCIFY, filesystem,
# environment, per-profile -O/-g/assertions, exports, SDL2 — are set ONCE on
# the z_generals target in GeneralsMD/Code/Main/CMakeLists.txt
# (EMSCRIPTEN_ASYNC_FLAGS / GX_PROFILE_FLAGS). They used to be duplicated here
# with different values (256/512 MB heap vs the real 1/2 GB, SAFE_HEAP=1 vs 0);
# a later -s flag silently wins, so this file only ever *looked* authoritative.
# The SDL3 cache variables that were here were dead too: the web build uses
# Emscripten's SDL2 port (-sUSE_SDL=2), SDL3 is never configured.
# GeneralsX @build WebPort 2026-10-21
# ----------------------------------------------------------------------------

# ============================================================================
# 2. Build Defines
# ============================================================================

add_definitions(-DPLATFORM_WEB=1)
add_definitions(-DNO_DXVK=1)
add_definitions(-DNO_WIN32=1)
add_definitions(-DNO_BINK=1)
add_definitions(-DNO_MILES=1)

# Disable GameSpy networking — sockets and multiplayer not supported in WASM.
# Game code guarded by #ifndef NO_GAMESPY will be compiled out.
add_definitions(-DNO_GAMESPY=1)

# The doubly-linked MPSB fast-path is enabled by default to allow O(1) removals.
# add_definitions(-DDISABLE_MEMORYPOOL_MPSB_DLINK=1)

# Disable MEMORYPOOL_BOUNDINGWALL debug feature: in WASM32 (4-byte pointers),
# the post-wall fill/check of a freed pool block overlaps with the immediately
# adjacent block's vtable pointer, zeroing it (SI-vptr=0 pattern). This cascades
# into DynamicMemoryAllocator free-list corruption where all new() calls return
# the same address, ultimately causing RuntimeError: function signature mismatch
# in virtual dispatch. Boundary-wall checking is a native-debug aid only.
add_definitions(-DDISABLE_MEMORYPOOL_BOUNDINGWALL=1)

# NUCLEAR OPTION: Bypass the custom memory pool entirely and use system
# malloc/free. Uses the GameMemoryNull.h path which replaces all pool
# allocators with standard heap allocations. Slightly slower but eliminates all
# pool-related corruption (POOL-DOUBLE-FREE, MPSB dlink, bounding wall).
# Requires a full rebuild: delete build-web/CMakeCache.txt then ninja.
set(RTS_GAMEMEMORY_ENABLE ON CACHE BOOL "Use the original GameMemory pool on web (OFF = GameMemoryNull / system malloc)" FORCE)

# Audio: the engine's unmodified MilesAudioManager links against the Miles-
# compatible Web Audio bridge (Dependencies/Miles/CMakeLists.txt -> target `milesloader`,
# Core/Libraries/Source/WebAudioBridge/web_audio_bridge.cpp). There is no
# OpenAL path; the former SAGE_USE_OPENAL knob was read by nothing.
# GeneralsX @build WebPort 2026-10-21

# ============================================================================
# 3. GLES3 Wrapper Sources
# ============================================================================

# Source files are in WW3D2 directory (alongside DX8 wrapper sources)
set(WW3D2_DIR ${CMAKE_SOURCE_DIR}/GeneralsMD/Code/Libraries/Source/WWVegas/WW3D2)

set(GLES3_WEB_SOURCES
    ${WW3D2_DIR}/gles3_wrapper.cpp
    ${WW3D2_DIR}/gles3_fvf.cpp
    ${WW3D2_DIR}/gles3_texture_utils.cpp
    ${WW3D2_DIR}/gles3_big_vfs.cpp
    ${WW3D2_DIR}/gles3_mainloop.cpp
    ${WW3D2_DIR}/dx8_fixedfunction_shaders.cpp
)

set(GLES3_WEB_HEADERS
    ${WW3D2_DIR}/gles3_wrapper.h
    ${WW3D2_DIR}/gles3_fvf.h
    ${WW3D2_DIR}/gles3_texture_utils.h
    ${WW3D2_DIR}/gles3_big_vfs.h
    ${WW3D2_DIR}/gles3_mainloop.h
)

# Create INTERFACE library for include paths
add_library(gles3_web INTERFACE)
target_include_directories(gles3_web INTERFACE ${WW3D2_DIR})

# Emscripten entry point
set(EMSCRIPTEN_MAIN_SOURCE
    ${CMAKE_SOURCE_DIR}/GeneralsMD/Code/Main/EmscriptenMain.cpp
)

# ============================================================================
# 4. d3d8lib Replacement Target
#
# On Windows, d3d8lib provides DirectX 8 headers.
# On Linux, d3d8lib provides DXVK headers.
# On Web, we create a stub d3d8lib that provides our GLES3 headers instead.
# ============================================================================

if(NOT TARGET d3d8lib)
    add_library(d3d8lib INTERFACE)
    target_include_directories(d3d8lib INTERFACE
        # Emscripten compat: d3d8*.h, dinput.h, windows_base.h stubs
        # (the Win32 type/function stubs too — there is no CompatLib in this tree)
        ${WW3D2_DIR}/emscripten_compat
    )
    target_compile_definitions(d3d8lib INTERFACE
        PLATFORM_WEB=1
        NO_DXVK=1
        NO_D3D8=1
    )
endif()

# Also create d3d8 and d3dx8 as stub targets if they don't exist
# (some link targets reference these directly)
if(NOT TARGET d3d8)
    add_library(d3d8 INTERFACE)
endif()
if(NOT TARGET d3dx8)
    add_library(d3dx8 INTERFACE)
endif()

message(STATUS "Web port sources: ${GLES3_WEB_SOURCES}")
message(STATUS "Web port ready for build")
