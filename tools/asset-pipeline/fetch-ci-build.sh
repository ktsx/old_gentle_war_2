#!/usr/bin/env bash
# fetch-ci-build.sh — wait until CI has published the build of a commit, then download it.
#
# The web build publishes rolling releases ~2 minutes after a push (Emscripten build with a warm
# ccache), long before the boot smoke tests finish (~8 more minutes). Pulling the binary straight
# from the release lets a change be tested locally right away; the smoke tests only have to be
# green before the merge.
#
#   main      -> ci-latest-release (Release) / ci-latest (RelWithDebInfo)
#   merge/**  -> ci-branch-release           / ci-branch
#
# usage: tools/asset-pipeline/fetch-ci-build.sh <sha> <outDir> [tag]
#   tag defaults to ci-branch-release; the script exits non-zero if the build job for <sha> fails.
#   Downloads GeneralsZH.{html,js,wasm}, GeneralsZH.symbols (if published), serve.py and the launcher.
set -euo pipefail
sha="${1:?usage: fetch-ci-build.sh <sha> <outDir> [tag]}"
out="${2:?usage: fetch-ci-build.sh <sha> <outDir> [tag]}"
tag="${3:-ci-branch-release}"
repo="${GITHUB_REPOSITORY:-ktsx/old_gentle_war_2}"
sha=$(git rev-parse "$sha" 2>/dev/null || echo "$sha")
mkdir -p "$out"

start=$(date +%s)
until [ "$(gh api "repos/$repo/releases/tags/$tag" --jq .target_commitish 2>/dev/null)" = "$sha" ]; do
  # stop early when the build job of this commit failed
  if gh api "repos/$repo/commits/$sha/check-runs?per_page=50" \
       --jq '.check_runs[] | select(.name|test("Emscripten Build")) | .conclusion' 2>/dev/null | grep -q failure; then
    echo "build of ${sha:0:9} failed" >&2; exit 1
  fi
  sleep 15
done
echo "release $tag = ${sha:0:9} after $(( $(date +%s) - start )) s"
for a in GeneralsZH.html GeneralsZH.js GeneralsZH.wasm GeneralsZH.symbols serve.py index.html launcher.js sw.js manifest.webmanifest icon-192.png icon-512.png; do
  id=$(gh api "repos/$repo/releases/tags/$tag" --jq ".assets[] | select(.name==\"$a\") | .id")
  [ -n "$id" ] || continue
  gh api -H "Accept: application/octet-stream" "repos/$repo/releases/assets/$id" > "$out/$a"
done
ls -la "$out"
