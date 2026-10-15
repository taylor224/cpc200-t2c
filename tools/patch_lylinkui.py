#!/usr/bin/env python3
"""Patch the adapter's lylinkui so its built-in DNS server also answers carplay.lan.

    tools/patch_lylinkui.py path/to/app/lylinkui

lylinkui (branch 1508, the copy in the 26090414 image) contains a small DNS responder
("dnsd", process_request at 0x20a90). Stock behaviour:

  * while the phone's internet works (dnsd_disable(1) after data.carlinkit.com resolves)
    every query is dropped;
  * otherwise names in a static table (tespush.cn/.com, www.tespush.cn/.com) are answered
    with the adapter's Tesla-UI address, any name with a label containing "tesla" is
    answered with the same address (TTL 0, the fake connectivity check), the rest REFUSED.

After this patch:

  * the table also contains carplay.lan (it replaces a duplicate tespush.com entry);
  * table names are answered in both states, so carplay.lan works whether or not the
    phone has internet;
  * while the phone has internet, every other name is still dropped exactly as before,
    in particular the "tesla" catch-all stays off;
  * the per-query debug log line ("q: <name>, type:<n>") is gone; its format string holds
    the new name.

The script refuses to touch a file whose SHA-256 is not the known original, so it
cannot misapply offsets to a different build.
"""
import hashlib
import struct
import sys

TEXT_VA, TEXT_OFF, TEXT_SZ = 0x10000, 0x0, 0x1c68c        # first PT_LOAD: r-x
DATA_VA, DATA_OFF, DATA_SZ = 0x3cb40, 0x1cb40, 0x5c0       # second PT_LOAD: rw- (file part)

DROP = 0x20d94           # "no reply, back to select()" in process_request
NO_MATCH = 0x20bc4       # start of the "tesla" catch-all / REFUSED path
TABLE_LOOP = 0x20b74     # load table {count, entries} and start comparing
CAVE = 0x20b40           # inside the removed logging block

NAME_VA = 0x2b7f6        # "%s|%d:q: %s, type:%d\0" (21 bytes), only used by that log call
NAME_WIRE = b'\x07carplay\x03lan\x00'
TABLE_ENTRY2 = 0x3d0a8 + 2 * 8   # {ptr, len}; entry 2 duplicates entry 1 (tespush.com)


def b_insn(cond, at, target):
    off = (target - (at + 8)) >> 2
    return struct.pack('<I', (cond << 28) | (0b1010 << 24) | (off & 0xFFFFFF))


AL, NE, GE = 0xE, 0x1, 0xA
MOV_R0_R0 = struct.pack('<I', 0xE1A00000)
MOV_R7_0 = struct.pack('<I', 0xE3A07000)
LDR_R3_SP_18 = struct.pack('<I', 0xE59D3018)
CMP_R3_0 = struct.pack('<I', 0xE3530000)


def foff(va):
    if TEXT_VA <= va < TEXT_VA + TEXT_SZ:
        return va - TEXT_VA + TEXT_OFF
    if DATA_VA <= va < DATA_VA + DATA_SZ:
        return va - DATA_VA + DATA_OFF
    raise ValueError(hex(va))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    data = bytearray(open(path, 'rb').read())
    sha = hashlib.sha256(data).hexdigest()
    if sha == PATCHED_SHA256:
        print('lylinkui already patched (%s)' % sha[:16])
        return
    if sha != ORIGINAL_SHA256:
        sys.exit('lylinkui sha256 %s is not the known 26090414 build; refusing to patch' % sha)

    def put(va, new, expect=None):
        o = foff(va)
        if expect is not None and bytes(data[o:o + len(expect)]) != expect:
            sys.exit('unexpected bytes at %#x: %s' % (va, bytes(data[o:o + len(expect)]).hex()))
        data[o:o + len(new)] = new

    add_r8_sp_348 = bytes(data[foff(0x20b64):foff(0x20b64) + 4])

    # 1. keep processing while "disabled" (was: bne DROP)
    put(0x20ab0, MOV_R0_R0, expect=b_insn(NE, 0x20ab0, DROP))
    # 2. replace the print_domain log call with the setup it interleaved, plus a cave:
    #    no table match -> if disabled (stack flag still holds the disable value) drop,
    #    otherwise continue with the stock catch-all / REFUSED path
    block = (MOV_R7_0 + add_r8_sp_348 + b_insn(AL, 0x20b3c, TABLE_LOOP) +
             LDR_R3_SP_18 + CMP_R3_0 + b_insn(NE, 0x20b48, DROP) + b_insn(AL, 0x20b4c, NO_MATCH))
    block += MOV_R0_R0 * ((TABLE_LOOP - 0x20b34 - len(block)) // 4)
    assert 0x20b34 + len(block) == TABLE_LOOP
    put(0x20b34, block)
    # 3. "loop exhausted" now goes through the cave
    put(0x20b84, b_insn(GE, 0x20b84, CAVE), expect=b_insn(GE, 0x20b84, NO_MATCH))
    # 4. the freed format string becomes the wire-format name carplay.lan
    put(NAME_VA, NAME_WIRE + b'\x00' * (21 - len(NAME_WIRE)), expect=b'%s|%d:q: %s, type:%d\x00')
    # 5. table entry 2 (duplicate of tespush.com) -> carplay.lan
    put(TABLE_ENTRY2, struct.pack('<II', NAME_VA, len(NAME_WIRE)), expect=struct.pack('<II', 0x2b781, 13))

    out = hashlib.sha256(data).hexdigest()
    if out != PATCHED_SHA256:
        sys.exit('patched sha256 %s does not match the expected %s' % (out, PATCHED_SHA256))
    open(path, 'r+b').write(bytes(data))
    print('lylinkui patched: dnsd answers carplay.lan (%s)' % out[:16])


ORIGINAL_SHA256 = '37ce2c3a412545cb1e0cbb28c87ec6a8a7558332b99e20ab9f88a6c794e11e98'
PATCHED_SHA256 = '15ee6755b03ee6f690d1796c961af8fad551e77099175959a84a9ab37770e302'

if __name__ == '__main__':
    main()
