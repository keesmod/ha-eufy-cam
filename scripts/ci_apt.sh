#!/usr/bin/env bash
# Carry apt's downloaded packages between Validate runs with actions/cache.
# The Ubuntu mirror on the runners is sometimes very slow, so a run downloads
# only what no earlier run of the same job saved.
#
#   keys NAME  print the cache key and restore keys for job NAME
#   start      point every apt call at ~/apt-archives and remember its files
#   changed    print changed=true when this run added packages to the folder
set -euo pipefail

archives="$HOME/apt-archives"
listing="$RUNNER_TEMP/apt-archives-before"

case "${1:-}" in
  keys)
    prefix="apt-$2-$ImageOS-"
    {
      echo "key=$prefix$ImageVersion-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
      echo "image=$prefix$ImageVersion-"
      echo "os=$prefix"
    } >> "$GITHUB_OUTPUT"
    ;;
  start)
    mkdir -p "$archives/partial"
    echo "Dir::Cache::Archives \"$archives/\";" |
      sudo tee /etc/apt/apt.conf.d/90-ci-archives > /dev/null
    (cd "$archives" && ls -- *.deb 2> /dev/null || true) > "$listing"
    ;;
  changed)
    # A run that failed before start has nothing to compare and saves nothing.
    changed=false
    if [ -f "$listing" ]; then
      # Drop packages the mirror no longer offers, so the cache stays bounded.
      sudo apt-get autoclean -qq || true
      current=$(cd "$archives" && ls -- *.deb 2> /dev/null || true)
      [ "$current" = "$(cat "$listing")" ] || changed=true
    fi
    echo "changed=$changed" >> "$GITHUB_OUTPUT"
    echo "New apt packages to save: $changed"
    ;;
  *)
    echo "usage: $0 keys NAME | start | changed" >&2
    exit 2
    ;;
esac
