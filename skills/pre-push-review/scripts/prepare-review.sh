#!/bin/sh
set -eu
set -f

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

case $0 in
  /*/*) script_parent=${0%/*} ;;
  *) fail 'the review launcher needs an absolute script path' ;;
esac
script_directory=$(CDPATH= cd -P "$script_parent" && pwd -P) ||
  fail 'cannot resolve the review launcher directory'
initial_directory=$(pwd -P) || fail 'cannot resolve the current directory'

current=$initial_directory
repository_envelope=
while :; do
  if [ -e "$current/.git" ] || [ -L "$current/.git" ]; then
    repository_envelope=$current
  fi
  [ "$current" = / ] && break
  current=${current%/*}
  [ -n "$current" ] || current=/
done

[ -n "$repository_envelope" ] || fail 'cannot find a .git repository boundary'
[ "$repository_envelope" != / ] || fail 'the repository boundary cannot be the file-system root'

old_ifs=$IFS
IFS=:
for entry in ${PATH-}; do
  case $entry in
    /*) ;;
    *) continue ;;
  esac
  canonical_entry=$(CDPATH= cd -P "$entry" 2>/dev/null && pwd -P) || continue
  case "$canonical_entry/" in
    "$repository_envelope/"*) continue ;;
  esac
  node_executable=$canonical_entry/node
  if [ -f "$node_executable" ] && [ -x "$node_executable" ] && [ ! -L "$node_executable" ]; then
    IFS=$old_ifs
    exec "$node_executable" "$script_directory/prepare-review.cjs"
  fi
done
IFS=$old_ifs

fail 'cannot find a trusted non-symlink Node.js executable outside the reviewed repository'
