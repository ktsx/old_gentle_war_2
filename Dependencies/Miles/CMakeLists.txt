# GeneralsX @merge 2026-10-21 — on the web there is no mss32.dll: the Miles API
# is implemented by the Web Audio bridge, and MilesLoader::load() is a no-op.
if(EMSCRIPTEN)
    set(MILES_SRC
        mss/mss.h
        MilesLoaderWeb.cpp
        MilesLoader.h
        ${CMAKE_SOURCE_DIR}/Core/Libraries/Source/WebAudioBridge/web_audio_bridge.cpp
    )
else()
    set(MILES_SRC
        mss/mss.h
        MilesLoader.cpp
        MilesLoader.h
    )
endif()

## milesloader

add_library(milesloader STATIC)
set_target_properties(milesloader PROPERTIES OUTPUT_NAME milesloader)

target_sources(milesloader PRIVATE ${MILES_SRC})

target_include_directories(milesloader PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}     # include "mss/mss.h" and "MilesLoader.h"
    ${CMAKE_CURRENT_SOURCE_DIR}/mss # include "mss.h"
)

target_link_libraries(milesloader PRIVATE
    core_utility
)
