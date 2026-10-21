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

add_library(deps_miles STATIC)

target_sources(deps_miles PRIVATE ${MILES_SRC})

target_include_directories(deps_miles PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/mss
)

target_link_libraries(deps_miles PRIVATE
    depsi_always # Gives force included headers. Link early.
    deps_utility
)
