#!/usr/bin/env bash
# Races release commits against a throwaway remote, the way three release
# workflows do when one push touches several products.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/push_release_commit.sh"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
export RELEASE_PUSH_RETRY_DELAY=0
failed=0

check() {
  if ! "$@"; then
    echo "FAIL: ${CHECK_NAME}" >&2
    failed=1
  fi
}

new_clone() {
  git clone -q "${work}/remote.git" "${work}/$1" 2>/dev/null
  git -C "${work}/$1" config user.name test
  git -C "${work}/$1" config user.email test@example.test
}

release_commit() {
  # release_commit <clone> <file> <text>
  echo "$3" > "${work}/$1/$2"
  git -C "${work}/$1" add "$2"
  git -C "${work}/$1" commit -q -m "chore: release $2"
}

git init -q --bare -b main "${work}/remote.git"
new_clone seed
echo base > "${work}/seed/base.txt"
git -C "${work}/seed" add base.txt
git -C "${work}/seed" commit -q -m base
git -C "${work}/seed" push -q origin HEAD:main

# Both clones start from the same commit, as two workflows on one push do.
new_clone web
new_clone app
release_commit web web.txt 0.15.0
release_commit app app.txt 0.5.0

CHECK_NAME="the first release pushes"
check bash -c "cd '${work}/web' && bash '${script}'"

CHECK_NAME="the second release is rebased and pushed, not rejected"
check bash -c "cd '${work}/app' && bash '${script}'"

remote_files="$(git -C "${work}/remote.git" ls-tree -r --name-only main | sort | tr '\n' ' ')"
CHECK_NAME="main holds both releases"
check test "${remote_files}" = "app.txt base.txt web.txt "
CHECK_NAME="the rebased commit is what HEAD points at, so a tag lands on the pushed commit"
check test "$(git -C "${work}/app" rev-parse HEAD)" = "$(git -C "${work}/remote.git" rev-parse main)"
CHECK_NAME="history stays linear"
check test "$(git -C "${work}/remote.git" rev-list --merges main | wc -l)" = "0"

# A release job builds things before it commits, and a build can rewrite a
# tracked file (the app regenerates build/icon-512.png). That unstaged change
# must not stop the rebase.
new_clone dirty
release_commit dirty dirty.txt 1.0.0
new_clone mover
release_commit mover other.txt other
git -C "${work}/mover" push -q origin HEAD:main
echo "rebuilt" > "${work}/dirty/base.txt"
CHECK_NAME="a dirty working tree does not stop the rebase and push"
check bash -c "cd '${work}/dirty' && bash '${script}'"
CHECK_NAME="the release reached main"
check test "$(git -C "${work}/remote.git" show main:dirty.txt)" = "1.0.0"
CHECK_NAME="the rebuilt file is still there after the push"
check test "$(cat "${work}/dirty/base.txt")" = "rebuilt"

# Two releases that edit the same file cannot both go in. The second must fail
# and leave its clone usable, not stuck mid-rebase.
new_clone first
new_clone second
release_commit first same.txt one
release_commit second same.txt two
( cd "${work}/first" && bash "${script}" )
CHECK_NAME="a real conflict fails the job"
if ( cd "${work}/second" && bash "${script}" ) >/dev/null 2>&1; then
  echo "FAIL: ${CHECK_NAME}" >&2
  failed=1
fi
CHECK_NAME="a failed rebase is aborted, not left half done"
check test ! -d "${work}/second/.git/rebase-merge" -a ! -d "${work}/second/.git/rebase-apply"
CHECK_NAME="the remote keeps only the commit that got there first"
check test "$(git -C "${work}/remote.git" show main:same.txt)" = "one"

exit "${failed}"
