#!/usr/bin/env bash
# Pushes the release commit at HEAD to the release branch, usually main.
#
# One push can change several products, and then a release workflow starts for
# each of them at the same time. Each makes its own version commit, so
# whichever pushes second finds main has moved and is rejected. A release
# commit only touches its own product's version files, which means it can be
# rebased onto the new main without a conflict. This pushes, and on a
# rejection rebases onto the current main and pushes again.
#
# The job has usually built things by now, and a build can rewrite a tracked
# file, so the rebase sets such changes aside and puts them back.
#
# HEAD changes when it is rebased. Tag HEAD afterwards, not the old commit.
#
# usage: push_release_commit.sh [branch] [remote]
set -euo pipefail

branch="${1:-main}"
remote="${2:-origin}"
attempts=5
delay="${RELEASE_PUSH_RETRY_DELAY:-2}"

for attempt in $(seq 1 "${attempts}"); do
  if git push "${remote}" "HEAD:${branch}"; then
    exit 0
  fi
  if [[ "${attempt}" -eq "${attempts}" ]]; then
    echo "Could not push the release commit after ${attempts} attempts." >&2
    exit 1
  fi
  echo "Push rejected; rebasing onto ${remote}/${branch} (attempt ${attempt} of ${attempts})." >&2
  git fetch "${remote}" "${branch}"
  if ! git rebase --autostash "${remote}/${branch}"; then
    git rebase --abort 2>/dev/null || true
    echo "The release commit conflicts with ${remote}/${branch}. Another change touched the same version file." >&2
    exit 1
  fi
  sleep "$((attempt * delay))"
done
