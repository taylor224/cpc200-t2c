#!/usr/bin/env python3
"""Decode the adapter's log download (GET /cgi-bin/index.cgi?id=logcat).

The CGI builds `(dmesg && logcat -v threadtime -d) | gzip -c > /tmp/log.gz` and then
obfuscates the file while sending it:

  * the 32-bit little-endian file size is inserted after byte 819 of the gzip stream;
  * the resulting stream is XORed in 1024-byte blocks with the 14-byte key
    "liaoyuan.tech\\0" (the key index restarts at every block).

Usage: tools/logcat.py log.bin [log.txt]
       curl -s http://192.168.3.1/cgi-bin/index.cgi?id=logcat | tools/logcat.py - log.txt
"""
import struct
import sys
import zlib

KEY = b'liaoyuan.tech\x00'
BLOCK = 1024
SIZE_AT = 819


def decode(data):
    x = bytes(b ^ KEY[(i % BLOCK) % len(KEY)] for i, b in enumerate(data))
    if len(x) > SIZE_AT + 4:
        declared = struct.unpack('<I', x[SIZE_AT:SIZE_AT + 4])[0]
        gz = x[:SIZE_AT] + x[SIZE_AT + 4:]
        if declared != len(gz):
            sys.stderr.write('warning: declared size %d != payload %d\n' % (declared, len(gz)))
    else:
        gz = x
    return zlib.decompress(gz, 16 + zlib.MAX_WBITS)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    data = sys.stdin.buffer.read() if src == '-' else open(src, 'rb').read()
    out = decode(data)
    if len(sys.argv) > 2:
        open(sys.argv[2], 'wb').write(out)
    else:
        sys.stdout.buffer.write(out)


if __name__ == '__main__':
    main()
