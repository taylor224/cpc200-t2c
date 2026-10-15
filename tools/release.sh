#!/usr/bin/env bash
# Build a versioned image, publish it as a GitHub release and point updates/1508/version.json at it.
#
#   tools/release.sh YYMMDDNN [NOTES.md] [BASE_IMG]
#
# Steps: T2C_VERSION=YYMMDDNN tools/build.sh -> build/T2C-tesla-ui-YYMMDDNN.img
#        write updates/1508/version.json (appver/tsl/url/msg), commit, push main
#        gh release create vYYMMDDNN with the image as asset
# Requires: gh (logged in), git remote "origin" on GitHub. Run from a checkout of main.
set -euo pipefail
cd "$(dirname "$0")/.."
V="${1:?usage: release.sh YYMMDDNN [NOTES.md] [BASE_IMG]}"
NOTES="${2:-}"
BASE="${3:-}"
[[ "$V" =~ ^[0-9]{8}$ ]] || { echo "version must be 8 digits (YYMMDDNN)" >&2; exit 1; }
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
BRANCH=1508
IMG="build/T2C-tesla-ui-$V.img"
ASSET="T2C-tesla-ui-$V.img"
# GitHub release assets carry no CORS headers, so the pages download the copy on the
# orphan "releases" branch through raw.githubusercontent.com (which sends ACAO: *).
URL="https://raw.githubusercontent.com/$REPO/releases/$BRANCH/$ASSET"
RELEASE_PAGE="https://github.com/$REPO/releases/tag/v$V"

echo "== build $IMG"
T2C_VERSION="$V" tools/build.sh ${BASE:+"$BASE"} "$IMG" | tail -3
SHA=$(shasum -a 256 "$IMG" | cut -d' ' -f1)
SIZE=$(stat -f %z "$IMG" 2>/dev/null || stat -c %s "$IMG")

echo "== updates/$BRANCH/version.json"
MSG="T2C Tesla UI build $V"
if [ -n "$NOTES" ] && [ -f "$NOTES" ]; then MSG=$(grep -m1 -vE '^\s*(#|$)' "$NOTES" | cut -c1-200); fi
python3 - "$V" "$URL" "$MSG" "$BRANCH" "$RELEASE_PAGE" <<'EOF'
import json, sys, os
v, url, msg, branch, page = sys.argv[1:6]
p = os.path.join('updates', branch, 'version.json')
j = json.load(open(p)) if os.path.exists(p) else {}
j.update({'appver': '%s.%s.1' % (v, branch), 'tsl': '%s.5.4' % v, 'url': url, 'msg': msg, 'release': page})
json.dump(j, open(p, 'w'), indent=2, ensure_ascii=False); open(p, 'a').write('\n')
print(open(p).read())
EOF

echo "== image -> releases branch (raw.githubusercontent.com)"
WT=$(mktemp -d)
if git ls-remote --exit-code --heads origin releases >/dev/null 2>&1; then
  git fetch -q origin releases && git worktree add -q "$WT" origin/releases --detach && git -C "$WT" checkout -q -B releases
else
  git worktree add -q --detach "$WT" HEAD && git -C "$WT" checkout -q --orphan releases && git -C "$WT" rm -rfq --cached . && find "$WT" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
fi
mkdir -p "$WT/$BRANCH" && cp "$IMG" "$WT/$BRANCH/$ASSET"
git -C "$WT" add -A && git -C "$WT" commit -q -m "Release $V image" && git -C "$WT" push -q origin releases
git worktree remove --force "$WT"

echo "== commit + push version.json"
git add "updates/$BRANCH/version.json"
git commit -q -m "Release $V" || true
git push origin HEAD:main

echo "== release v$V ($SIZE bytes, sha256 $SHA)"
if [ -n "$NOTES" ] && [ -f "$NOTES" ]; then
  gh release create "v$V" --target main --title "T2C Tesla UI $V" --notes-file "$NOTES"
else
  gh release create "v$V" --target main --title "T2C Tesla UI $V" --notes "T2C Tesla UI build $V. SHA-256 $SHA, $SIZE bytes."
fi
# upload separately so a slow link can be retried without recreating the release
for i in 1 2 3; do gh release upload "v$V" "$IMG#$ASSET" --clobber && break; echo "upload failed, retry $i"; sleep 5; done
echo "== done: $URL"
