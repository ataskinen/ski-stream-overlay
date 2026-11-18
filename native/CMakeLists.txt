cmake_minimum_required(VERSION 4.2)
project(SkiRaceOverlay VERSION 0.1.0 LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "This CMake entry point requires Windows x64 and MSVC. Use build-plugin.sh for macOS.")
endif()
if(CMAKE_GENERATOR_PLATFORM AND NOT CMAKE_GENERATOR_PLATFORM STREQUAL "x64")
  message(FATAL_ERROR "Use the x64 generator platform, not ARM64 or Win32.")
endif()

# A complete SDK exported by OBS 33.0.1 is required. Its imported target carries
# generated obsconfig.h, SIMDe, w32-pthreads and the matching obs.lib import library.
# Do not substitute raw source headers plus an unrelated import library.
find_package(libobs 33.0.1 EXACT CONFIG REQUIRED)
if(NOT TARGET OBS::libobs)
  message(FATAL_ERROR "The supplied SDK must export OBS::libobs.")
endif()

add_library(SkiRaceOverlay MODULE ski-race-overlay.cpp)
target_compile_features(SkiRaceOverlay PRIVATE cxx_std_17)
target_compile_definitions(SkiRaceOverlay PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_compile_options(SkiRaceOverlay PRIVATE /W4 /utf-8 /permissive-)
target_link_libraries(SkiRaceOverlay PRIVATE OBS::libobs ws2_32 shell32)
set_target_properties(SkiRaceOverlay PROPERTIES PREFIX "" OUTPUT_NAME "SkiRaceOverlay")
install(TARGETS SkiRaceOverlay RUNTIME DESTINATION bin/64bit LIBRARY DESTINATION bin/64bit)

enable_testing()
add_executable(windows-command-test windows-command-test.cpp)
target_compile_features(windows-command-test PRIVATE cxx_std_17)
target_compile_options(windows-command-test PRIVATE /utf-8)
add_test(NAME windows-command-quoting COMMAND windows-command-test)
