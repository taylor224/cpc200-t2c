#!/usr/bin/env bash
# Build a patched T2C firmware image: base image -> replace app/www with src/www -> repack.
#
#   tools/build.sh [BASE_IMG] [OUT_IMG]
#
# Defaults: BASE_IMG=test.img (falls back to update.img), OUT_IMG=build/T2C-tesla-ui.img
# Requires: python3, unsquashfs, mksquashfs (brew install squashfs), cpio not needed.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-}"
if [ -z "$BASE" ]; then
  if [ -f test.img ]; then BASE=test.img; elif [ -f update.img ]; then BASE=update.img; else
    echo "no base image: put the official update.img (or test.img) in the repo root" >&2; exit 1; fi
fi
OUT="${2:-build/T2C-tesla-ui.img}"
WORK=work
rm -rf "$WORK" && mkdir -p "$WORK" build

echo "== base: $BASE"
python3 tools/swu.py unpack "$BASE" "$WORK/swu"

echo "== unsquash customer"
# The image contains /dev/console (char 5,1); unsquashfs cannot create device nodes
# without root, so tolerate that and recreate every special inode via a pseudo-file.
unsquashfs -q -n -d "$WORK/customer" "$WORK/swu/customer" >/dev/null 2>"$WORK/unsquash.err" || true
grep -v 'could not create character device\|could not create block device\|^$' "$WORK/unsquash.err" | grep -q . && { cat "$WORK/unsquash.err" >&2; exit 1; }
[ -f "$WORK/customer/app/lylinkui" ] || { echo "unsquashfs failed" >&2; exit 1; }
unsquashfs -lln "$WORK/swu/customer" 2>/dev/null | awk '$1 ~ /^[cb]/ {
  mode=$1; sub(/,$/,"",$3); maj=$3; min=$4; path=$NF; sub(/^squashfs-root\//,"",path);
  split($2,ug,"/"); perm=0;
  for(i=2;i<=10;i++){ c=substr(mode,i,1); perm=perm*2+(c!="-"); }
  printf "%s %s %o %s %s %s %s\n", path, substr(mode,1,1), perm, ug[1], ug[2], maj, min }' > "$WORK/pseudo.txt"
echo "   special inodes:"; sed 's/^/     /' "$WORK/pseudo.txt"

echo "== overlay src/www -> app/www"
rm -rf "$WORK/customer/app/www"
mkdir -p "$WORK/customer/app/www"
# Copy only what the adapter needs; drop editor/OS junk.
rsync -a --exclude '.DS_Store' --exclude '*.map' src/www/ "$WORK/customer/app/www/"
# The adapter serves index.html generated from index.in; ship a pre-rendered copy too
# so the very first page load (before the template runs) is already the new UI.
python3 - "$WORK/customer/app/www" <<'EOF'
import sys, os
www = sys.argv[1]
src = open(os.path.join(www, 'index.in'), encoding='utf-8').read()
assert '|' not in src, 'index.in must not contain "|" (template token character)'
open(os.path.join(www, 'index.html'), 'w', encoding='utf-8').write(src)
for n in range(3):
    p = os.path.join(www, 'lan', '%d.txt' % n)
    assert os.path.exists(p), p
    lines = open(p, encoding='utf-8').read().split('\n')
    assert len(lines) <= 128, '%s has more than 128 lines (template table overflow)' % p
EOF
find "$WORK/customer/app/www" -type f -exec chmod 755 {} +   # match original image (all 0755)
find "$WORK/customer/app/www" -type d -exec chmod 755 {} +

echo "== mksquashfs"
rm -f "$WORK/customer.sqfs"
mksquashfs "$WORK/customer" "$WORK/customer.sqfs" -comp xz -b 262144 -noappend -all-root -no-xattrs -no-progress -quiet -pf "$WORK/pseudo.txt"
ORIG=$(stat -f %z "$WORK/swu/customer" 2>/dev/null || stat -c %s "$WORK/swu/customer")
NEW=$(stat -f %z "$WORK/customer.sqfs" 2>/dev/null || stat -c %s "$WORK/customer.sqfs")
echo "   customer: original $ORIG bytes -> new $NEW bytes"
cp "$WORK/customer.sqfs" "$WORK/swu/customer"

echo "== pack"
python3 tools/swu.py pack "$WORK/swu" "$OUT"
tools/verify.sh "$OUT"
echo "== done: $OUT"
