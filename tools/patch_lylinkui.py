#!/usr/bin/env python3
"""Patch the adapter's lylinkui so its built-in DNS server answers carplay.internal and
setting.internal.

    tools/patch_lylinkui.py path/to/app/lylinkui

lylinkui (branch 1508, the copy in the 26090414 image) contains a small DNS responder
("dnsd", process_request at 0x20a90). Stock behaviour:

  * while the phone's internet works (dnsd_disable(1) after data.carlinkit.com resolves)
    every query is dropped;
  * otherwise names in a static table (tespush.cn/.com, www.tespush.cn/.com) are answered
    with the adapter's Tesla-UI address, any name with a label containing "tesla" is
    answered with the same address (TTL 0, the fake connectivity check), the rest REFUSED.

After this patch:

  * the table also contains carplay.internal and setting.internal (they replace the two
    duplicate entries, tespush.com and www.tespush.com); carplay.internal is answered with
    the Tesla-UI address like the stock names, setting.internal with 192.168.3.1 (the
    phone-facing settings page served by busybox httpd);
  * table names are answered in both states, so the names work whether or not the phone
    has internet;
  * while the phone has internet, every other name is still dropped exactly as before,
    in particular the "tesla" catch-all stays off;
  * the per-query debug log line ("q: <name>, type:<n>") is gone; its call site holds the
    code caves.

The two wire-format names live in the zero padding after the read-only segment, which is
extended to cover them. The script refuses to touch a file whose SHA-256 is not the known
original, so it cannot misapply offsets to a different build.
"""
import hashlib
import struct
import sys

TEXT_VA, TEXT_OFF, TEXT_SZ = 0x10000, 0x0, 0x1c68c        # first PT_LOAD: r-x
DATA_VA, DATA_OFF, DATA_SZ = 0x3cb40, 0x1cb40, 0x5c0       # second PT_LOAD: rw- (file part)
TEXT_PHDR = 0x94                                           # program header of the r-x PT_LOAD

DROP = 0x20d94           # "no reply, back to select()" in process_request
NO_MATCH = 0x20bc4       # start of the "tesla" catch-all / REFUSED path
TABLE_LOOP = 0x20b74     # load table {count, entries} and start comparing
CAVE = 0x20b40           # inside the removed logging block
IP_CAVE = 0x20b50        # after CAVE, same block
IP_LOAD = 0x20ca8        # table answer: "ldr r3, [r3]" fetches the Tesla-UI address
IP_STORE = 0x20cac       # ... and "str r3, [r7, #-4]" puts it into the answer

NAMES_VA = TEXT_VA + TEXT_SZ + 4                           # 0x2c690, in the segment padding
CARPLAY = b'\x07carplay\x08internal\x00'
SETTING = b'\x07setting\x08internal\x00'
TABLE = 0x3d0a8                                            # {ptr, len}[6] for branch 1508
SETTINGS_IP = bytes([192, 168, 3, 1])


def b_insn(cond, at, target):
    off = (target - (at + 8)) >> 2
    return struct.pack('<I', (cond << 28) | (0b1010 << 24) | (off & 0xFFFFFF))


def movw(cond, rd, imm16):
    return struct.pack('<I', (cond << 28) | (0x30 << 20) | ((imm16 >> 12) << 16) | (rd << 12) | (imm16 & 0xFFF))


def movt(cond, rd, imm16):
    return struct.pack('<I', (cond << 28) | (0x34 << 20) | ((imm16 >> 12) << 16) | (rd << 12) | (imm16 & 0xFFF))


AL, NE, GE, EQ = 0xE, 0x1, 0xA, 0x0
MOV_R0_R0 = struct.pack('<I', 0xE1A00000)
MOV_R7_0 = struct.pack('<I', 0xE3A07000)
LDR_R3_SP_18 = struct.pack('<I', 0xE59D3018)
CMP_R3_0 = struct.pack('<I', 0xE3530000)
LDR_R3_R3 = struct.pack('<I', 0xE5933000)
LDRB_R2_R8_1 = struct.pack('<I', 0xE5D82001)     # first character of the first label
CMP_R2_S = struct.pack('<I', 0xE3520073)         # 's': only setting.internal starts \x07s


def foff(va):
    if TEXT_VA <= va < TEXT_VA + 0x1cb40:        # includes the padding the segment grows into
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
    ip = struct.unpack('<I', SETTINGS_IP)[0]

    # 1. keep processing while "disabled" (was: bne DROP)
    put(0x20ab0, MOV_R0_R0, expect=b_insn(NE, 0x20ab0, DROP))
    # 2. replace the print_domain log call with the setup it interleaved, plus two caves:
    #    CAVE: no table match -> if disabled (stack flag still holds the disable value) drop,
    #          otherwise continue with the stock catch-all / REFUSED path
    #    IP_CAVE: table answer for setting.internal carries 192.168.3.1 instead of the
    #          Tesla-UI address (r8 still points at the question name here)
    block = (MOV_R7_0 + add_r8_sp_348 + b_insn(AL, 0x20b3c, TABLE_LOOP) +
             LDR_R3_SP_18 + CMP_R3_0 + b_insn(NE, 0x20b48, DROP) + b_insn(AL, 0x20b4c, NO_MATCH) +
             LDR_R3_R3 + LDRB_R2_R8_1 + CMP_R2_S + movw(EQ, 3, ip & 0xFFFF) + movt(EQ, 3, ip >> 16) +
             b_insn(AL, IP_CAVE + 20, IP_STORE))
    block += MOV_R0_R0 * ((TABLE_LOOP - 0x20b34 - len(block)) // 4)
    assert 0x20b34 + len(block) == TABLE_LOOP
    put(0x20b34, block)
    # 3. "loop exhausted" now goes through the cave
    put(0x20b84, b_insn(GE, 0x20b84, CAVE), expect=b_insn(GE, 0x20b84, NO_MATCH))
    # 4. the table answer loads its address through IP_CAVE
    put(IP_LOAD, b_insn(AL, IP_LOAD, IP_CAVE), expect=LDR_R3_R3)
    # 5. the two names, in the padding after the r-x segment, which grows to include them
    names = CARPLAY + SETTING
    end = NAMES_VA + len(names) - TEXT_VA
    assert not any(data[TEXT_SZ:end]) and end < DATA_OFF
    put(NAMES_VA, names)
    put(TEXT_VA + TEXT_PHDR + 16, struct.pack('<II', end, end), expect=struct.pack('<II', TEXT_SZ, TEXT_SZ))
    # 6. table entries 2 and 5 (duplicates of tespush.com / www.tespush.com) -> the new names
    put(TABLE + 2 * 8, struct.pack('<II', NAMES_VA, len(CARPLAY)), expect=struct.pack('<II', 0x2b781, 13))
    put(TABLE + 5 * 8, struct.pack('<II', NAMES_VA + len(CARPLAY), len(SETTING)), expect=struct.pack('<II', 0x2b7a0, 17))

    out = hashlib.sha256(data).hexdigest()
    if out != PATCHED_SHA256:
        sys.exit('patched sha256 %s does not match the expected %s' % (out, PATCHED_SHA256))
    open(path, 'r+b').write(bytes(data))
    print('lylinkui patched: dnsd answers carplay.internal and setting.internal (%s)' % out[:16])


ORIGINAL_SHA256 = '37ce2c3a412545cb1e0cbb28c87ec6a8a7558332b99e20ab9f88a6c794e11e98'
PATCHED_SHA256 = '97c4d8e342b9b4876c4b2ad5124e3b538a3492605aa5a3f1f36ad3ef3831a2f8'

if __name__ == '__main__':
    main()
