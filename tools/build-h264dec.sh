#!/usr/bin/env bash
# Build the H.264 WebAssembly decoder (FFmpeg libavcodec, h264 decoder only) with Emscripten.
#
#   tools/build-h264dec.sh [WORKDIR] [nosimd]
#
# Produces src/www/js/h264dec.js + h264dec.wasm (requires WASM SIMD, Chromium >= 91).
# The .wasm is fetched by the worker and passed as wasmBinary, so the adapter's web
# server does not need to know the .wasm MIME type.
# Requires: emscripten (brew install emscripten) with Python >= 3.10 (EMSDK_PYTHON), curl, tar, xz.
# FFmpeg source is downloaded from ffmpeg.org and checked against a pinned SHA-256.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$ROOT/work/h264dec}"
FFVER=7.1.1
FFSHA=733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1
JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc)
export EMSDK_PYTHON="${EMSDK_PYTHON:-$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3)}"

mkdir -p "$WORK"
cd "$WORK"
if [ ! -f "ffmpeg-$FFVER.tar.xz" ]; then
  curl -sSL -o "ffmpeg-$FFVER.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFVER.tar.xz"
fi
echo "$FFSHA  ffmpeg-$FFVER.tar.xz" | shasum -a 256 -c -

build_variant() {   # $1 = simd|nosimd
  local v="$1" dir="$WORK/ff-$1" cflags="-O3"
  [ "$v" = simd ] && cflags="-O3 -msimd128"
  if [ ! -f "$dir/libavcodec/libavcodec.a" ]; then
    rm -rf "$dir"; mkdir -p "$dir"; tar -xJf "ffmpeg-$FFVER.tar.xz" -C "$dir" --strip-components=1
    (cd "$dir" && emconfigure ./configure \
      --target-os=none --arch=x86_32 --enable-cross-compile \
      --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc --ar=emar --ranlib=emranlib --nm=llvm-nm \
      --disable-everything --disable-all --disable-autodetect --disable-network --disable-debug \
      --disable-programs --disable-doc --disable-asm --disable-inline-asm --disable-x86asm \
      --disable-runtime-cpudetect --disable-pthreads --disable-w32threads --disable-os2threads \
      --enable-avcodec --enable-avutil --enable-decoder=h264 --enable-parser=h264 \
      --extra-cflags="$cflags" > configure.log 2>&1 || { tail -40 configure.log; exit 1; })
    (cd "$dir" && emmake make -j"$JOBS" libavcodec/libavcodec.a libavutil/libavutil.a libavcodec/aom_film_grain.o > make.log 2>&1 || { tail -40 make.log; exit 1; })
  fi
  # FFmpeg 7.1's Makefile only pulls aom_film_grain.o in for HEVC, but h2645_sei.o
  # (shared with H.264) references it; link the object explicitly.
  local out="$ROOT/src/www/js/h264dec" ; [ "$v" = nosimd ] && out="$ROOT/src/www/js/h264dec-nosimd"
  emcc "$ROOT/tools/h264dec/decoder.c" "$dir/libavcodec/aom_film_grain.o" "$dir/libavcodec/libavcodec.a" "$dir/libavutil/libavutil.a" \
    -I"$dir" $cflags \
    -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME=createH264Dec -s ENVIRONMENT=worker \
    -s FILESYSTEM=0 -s MALLOC=emmalloc -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=33554432 \
    -s STACK_SIZE=1048576 -s ASSERTIONS=0 -s INVOKE_RUN=0 -s NO_EXIT_RUNTIME=1 \
    -s EXPORTED_FUNCTIONS=_dec_init,_dec_decode,_dec_flush,_dec_width,_dec_height,_dec_format,_dec_colorspace,_dec_color_range,_dec_keyframe,_dec_plane,_dec_stride,_dec_close,_malloc,_free \
    -s EXPORTED_RUNTIME_METHODS=HEAPU8 \
    -s INCOMING_MODULE_JS_API=wasmBinary,locateFile,print,printErr,onAbort \
    -o "$out.js"
  # libwebsockets 3.2 (the adapter's web server) refuses files whose extension it does not
  # know and .wasm is not in its table, so the module is shipped as .wasm.txt and loaded
  # by the worker through wasmBinary.
  mv "$out.wasm" "$out.wasm.txt"
  ls -la "$out.js" "$out.wasm.txt"
}

build_variant simd
# A build without WASM SIMD can be produced with: tools/build-h264dec.sh WORKDIR nosimd
[ "${2:-}" = nosimd ] && build_variant nosimd
echo "done"
