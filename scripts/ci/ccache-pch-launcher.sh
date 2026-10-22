#!/bin/bash
# CMake compiler launcher for CI (CMAKE_C/CXX_COMPILER_LAUNCHER=<this script>).
#
# Runs the compiler command as given. When the command creates a precompiled
# header (-o <x>.pch), it additionally writes <x>.pch.sum = sha256 of the
# *preprocessed* PCH source with the same flags. With CCACHE_PCH_EXTSUM=1
# ccache hashes that .sum instead of the .pch: clang PCH files differ from run
# to run (so every TU using one missed the cache), while the preprocessed text
# is reproducible and still changes whenever any header inside the PCH changes.
"$@"
rc=$?
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
if [ $rc -eq 0 ] && [[ "$out" == *.pch ]]; then
  pp=()
  skip=0
  for a in "$@"; do
    if [ $skip -gt 0 ]; then skip=$((skip-1)); continue; fi
    case "$a" in
      -o) skip=1; continue;;
      -c) continue;;
      -Xclang) pp+=("$a"); continue;;
    esac
    # drop "-Xclang -emit-pch" (keep "-Xclang -include" etc.)
    if [ ${#pp[@]} -gt 0 ] && [ "${pp[-1]}" = "-Xclang" ] && [ "$a" = "-emit-pch" ]; then unset 'pp[-1]'; continue; fi
    pp+=("$a")
  done
  if "${pp[@]}" -E -P 2>"${out}.pp.err" | sha256sum | cut -d' ' -f1 > "$out.sum"; then
    [ -n "$CCACHE_LAUNCHER_LOG" ] && echo "pch ok $out $(cat "$out.sum")" >> "$CCACHE_LAUNCHER_LOG"
  else
    rm -f "$out.sum"
    [ -n "$CCACHE_LAUNCHER_LOG" ] && { echo "pch FAILED $out: ${pp[*]}"; head -5 "${out}.pp.err"; } >> "$CCACHE_LAUNCHER_LOG"
  fi
elif [ -n "$CCACHE_LAUNCHER_LOG" ] && [ -z "$CCACHE_LAUNCHER_SEEN" ]; then
  echo "first cmd: $*" >> "$CCACHE_LAUNCHER_LOG"; export CCACHE_LAUNCHER_SEEN=1
fi
exit $rc
