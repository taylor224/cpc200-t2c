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
  * while the phone has internet, every other name gets REFUSED instead of silence, so a
    resolver that asks the adapter first moves on to the next server at once (the DHCP list
    now starts with the adapter, otherwise 8.8.8.8's NXDOMAIN wins for the .internal names);
    the "tesla" catch-all stays off in that state;
  * table answers carry ARCOUNT 0: stock copies the query header, so a query with an EDNS
    OPT record got a reply that announced an additional record it did not contain, which
    macOS/iOS (mDNSResponder, always EDNS) discard as malformed and then take 8.8.8.8's
    NXDOMAIN — and cache it for a day;
  * the per-query debug log line ("q: <name>, type:<n>") is gone; its call site holds the
    code caves.

The two wire-format names live in the zero padding after the read-only segment, which is
extended to cover them.

It also changes how the H.264 stream leaves the WebSocket (callback_tsl, 0x16c6c):

  * stock cuts every access unit into 8168-byte messages (type 101/102/103; type 100 only
    when the whole unit fits), and each message costs an lws_write(), a
    lws_callback_on_writable() and a poll() round of the service thread; lws_issue_raw()
    additionally caps one send() at pt_serv_buf_size (4096, the default: lylinkui sets
    neither that nor the protocol's tx_packet_size), so even one 8 KB message takes two
    writes and an extra round. At 6-10 Mbit/s an access unit is 25-40 KB: about ten
    send() calls, ten poll rounds and ten TLS records per frame on the single core that
    also runs the CarPlay session, and the unit after it waits for all of them;
  * now a message carries up to 65280 bytes (payload still below 65536, so the WebSocket
    header keeps its 4-byte form and the LWS_PRE headroom is unchanged), type 100 is used
    up to 65508 bytes, and the "tsl" protocol's tx_packet_size lets lws send a message in
    one write. The page accepts type 100 at any size; larger units still arrive as
    101/102/103 and are reassembled as before.

Three more changes keep the CarPlay session alive across the car browser (2026-10-17):

  * when the page's WebSocket closes (Tesla closes or hides the browser, a reload, a second
    page taking over) stock lylinkui calls lylinkapi_cmd(2): lylinkapp "takes" the screen
    (CarPlay screen mode -> accessory), the video stops and the session is torn down, and
    the iPhone has to set everything up again when the page comes back -- navigation routes
    are lost on the way. Now the call is made only while no phone is attached (g+0x30c ==
    0: the adapter's own menu stream, which would otherwise keep encoding for nobody); with
    a phone the session simply runs on, the stream is dropped in the enqueue wrapper (patch
    10) and the returning page gets a key frame;
  * the page command VIDEO (cmd 0) called lylinkapi_cmd(3) ("untake", a new screen setup)
    whatever the state and moved the link state 1/2 -> 3; now a running stream (link == 2)
    is left alone -- the page only needs the key frame the handler asks for -- and only
    link 1 becomes 3;
  * ly_misc_thread's idle sleep is gone: stock counted 120 s (600 s after boot) with no
    phone, no page and no video, then ran `killall hostapd` and left the access point off
    until the phone came back over Bluetooth and asked for it. The relaunch went through
    the hostapd wrapper and the Bluetooth path; when either failed the adapter sat there
    without Wi-Fi ("the adapter's Wi-Fi is off and nothing connects"). The branch that
    enters the sleep is now unconditional-skip, so the countdown just wraps.

The script refuses to touch a file whose SHA-256 is not the known original, so it cannot
misapply offsets to a different build.
"""
import hashlib
import os
import struct
import sys

TEXT_VA, TEXT_OFF, TEXT_SZ = 0x10000, 0x0, 0x1c68c        # first PT_LOAD: r-x
DATA_VA, DATA_OFF, DATA_SZ = 0x3cb40, 0x1cb40, 0x5c0       # second PT_LOAD: rw- (file part)
TEXT_PHDR = 0x94                                           # program header of the r-x PT_LOAD

DROP = 0x20d94           # "no reply, back to select()" in process_request
NO_MATCH = 0x20bc4       # start of the "tesla" catch-all / REFUSED path
REFUSED = 0x20d18        # RCODE 5 into the header, send the query back (needs only r4/r5/r6)
TABLE_LOOP = 0x20b74     # load table {count, entries} and start comparing
CAVE = 0x20b40           # inside the removed logging block
IP_CAVE = 0x20b50        # after CAVE, same block
IP_LOAD = 0x20ca8        # table answer: "ldr r3, [r3]" fetches the Tesla-UI address
IP_STORE = 0x20cac       # ... and "str r3, [r7, #-4]" puts it into the answer

NAMES_VA = TEXT_VA + TEXT_SZ + 4                           # 0x2c690, in the segment padding
ENQUEUE = 0x1317c         # append a video access unit to the WebSocket thread's list (head g+0x260, tail g+0x264)
FREE_PLT = 0x11ec0        # free@plt
LWS_ON_WRITABLE_PLT = 0x12190   # lws_callback_on_writable@plt
LWS_SERVICE_PLT = 0x11e30       # lws_service@plt (main loop, 0x1a868)
LYLINKAPI_KEY_PLT = 0x12028     # lylinkapi_key@plt; (0x600, 0) + (0x600, 1) asks the phone for a key frame (page cmd 8)
LYLINKAPI_CMD_PLT = 0x12274     # lylinkapi_cmd@plt: 2 take the screen (page gone), 3 untake (page cmd VIDEO), 12 restart hostapd
G_PHONE = 0x30c                 # g+0x30c: a phone is attached (the link JSON's "phone")
QUEUE_LIMIT = 10          # access units allowed to wait for the page (~330 ms at 30 fps)
G_REF = 0x3d11c           # 'add r3, pc, r3 ; = 0x3d11c' then [r3+4] is the lylinkui global struct
CARPLAY = b'\x07carplay\x08internal\x00'
SETTING = b'\x07setting\x08internal\x00'
TABLE = 0x3d0a8                                            # {ptr, len}[6] for branch 1508
TSL_TX_PACKET_SIZE = 0x3d020 + 24                          # lws_protocols "tsl": .tx_packet_size
FRAG = 0xff00                                              # WebSocket video message payload (was 0x1fe8)
SETTINGS_IP = bytes([192, 168, 3, 1])


def b_insn(cond, at, target):
    off = (target - (at + 8)) >> 2
    return struct.pack('<I', (cond << 28) | (0b1010 << 24) | (off & 0xFFFFFF))


def bl_insn(at, target):
    off = (target - (at + 8)) >> 2
    return struct.pack('<I', (0xE << 28) | (0b1011 << 24) | (off & 0xFFFFFF))


def movw(cond, rd, imm16):
    return struct.pack('<I', (cond << 28) | (0x30 << 20) | ((imm16 >> 12) << 16) | (rd << 12) | (imm16 & 0xFFF))


def movt(cond, rd, imm16):
    return struct.pack('<I', (cond << 28) | (0x34 << 20) | ((imm16 >> 12) << 16) | (rd << 12) | (imm16 & 0xFFF))


def arm_imm(value):
    """12-bit ARM data-processing immediate (8 bits rotated right by an even amount)."""
    for rot in range(16):
        imm8 = ((value << (2 * rot)) | (value >> (32 - 2 * rot))) & 0xFFFFFFFF
        if imm8 < 256:
            return (rot << 8) | imm8
    raise ValueError('not encodable: %#x' % value)


def dp(cond, opcode, s, rn, rd, imm):
    """Data-processing instruction with an immediate operand (SUB/ADD/CMP ...)."""
    return struct.pack('<I', (cond << 28) | (1 << 25) | (opcode << 21) | (s << 20) | (rn << 16) | (rd << 12) | arm_imm(imm))


AL, NE, GE, EQ, LO = 0xE, 0x1, 0xA, 0x0, 0x3
SUB, ADD, CMP = 0x2, 0x4, 0xA
MOV_R0_R0 = struct.pack('<I', 0xE1A00000)
MOV_R7_0 = struct.pack('<I', 0xE3A07000)
LDR_R3_SP_18 = struct.pack('<I', 0xE59D3018)
CMP_R3_0 = struct.pack('<I', 0xE3530000)
LDR_R3_R3 = struct.pack('<I', 0xE5933000)
LDRB_R2_R8_1 = struct.pack('<I', 0xE5D82001)     # first character of the first label
MOV_R2_0 = struct.pack('<I', 0xE3A02000)
STRH_R2_R11_10 = struct.pack('<I', 0xE1CB20BA)   # ARCOUNT of the reply (r11 = header) = 0
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
    if sha in (PATCHED_SHA256, PATCHED_SHA256_WS):
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
    #    CAVE: no table match -> if disabled (stack flag still holds the disable value) answer
    #          REFUSED (stock: silence), otherwise continue with the stock catch-all / REFUSED path
    #    IP_CAVE: table answer for setting.internal carries 192.168.3.1 instead of the
    #          Tesla-UI address (r8 still points at the question name here), and the reply's
    #          ARCOUNT is cleared (r11 is still the header; stock echoes the query's count)
    block = (MOV_R7_0 + add_r8_sp_348 + b_insn(AL, 0x20b3c, TABLE_LOOP) +
             LDR_R3_SP_18 + CMP_R3_0 + b_insn(NE, 0x20b48, REFUSED) + b_insn(AL, 0x20b4c, NO_MATCH) +
             LDR_R3_R3 + LDRB_R2_R8_1 + CMP_R2_S + movw(EQ, 3, ip & 0xFFFF) + movt(EQ, 3, ip >> 16) +
             MOV_R2_0 + STRH_R2_R11_10 + b_insn(AL, IP_CAVE + 28, IP_STORE))
    block += MOV_R0_R0 * ((TABLE_LOOP - 0x20b34 - len(block)) // 4)
    assert 0x20b34 + len(block) == TABLE_LOOP
    put(0x20b34, block)
    # 3. "loop exhausted" now goes through the cave
    put(0x20b84, b_insn(GE, 0x20b84, CAVE), expect=b_insn(GE, 0x20b84, NO_MATCH))
    # 4. the table answer loads its address through IP_CAVE
    put(IP_LOAD, b_insn(AL, IP_LOAD, IP_CAVE), expect=LDR_R3_R3)
    # 5. the two names, in the padding after the r-x segment, which grows to include them
    names = CARPLAY + SETTING
    code_va = (NAMES_VA + len(names) + 3) & ~3
    # 10/11. The two callers of ENQUEUE (0x131dc: unit with SPS/PPS prepended = IDR, 0x1327c: other
    #     units) go through a wrapper that runs under the same lock as ENQUEUE:
    #     - no page attached (g+0x4c == 0): free the unit (stock leaked it: OOM kill every few minutes)
    #     - the list for the page (head g+0x260) already holds QUEUE_LIMIT units: drop this unit
    #       and every following one until the next IDR, and ask the lws thread for a key frame
    #       (FLAG = 1; it sends lylinkapi_key(0x600, 0/1) and sets FLAG = 2); re-ask every 64 drops
    #     - otherwise enqueue as before.
    #     FLAG is a new zeroed word: the rw PT_LOAD's memsz grows by 4 (DATA_VA + 0x89c).
    FLAG_VA = DATA_VA + 0x89c

    def build(base, prog):
        addr, pc = {}, base
        for it in prog:
            if it[0] == 'label': addr[it[1]] = pc
            else: pc += 4
        out, pc = b'', base
        for it in prog:
            k = it[0]
            if k == 'label': continue
            if k == 'w': out += struct.pack('<I', it[1])
            elif k == 'b': out += b_insn(it[1], pc, addr[it[2]] if isinstance(it[2], str) else it[2])
            elif k == 'bl': out += bl_insn(pc, addr[it[1]] if isinstance(it[1], str) else it[1])
            elif k == 'ldrpc':                      # ldr rX, [pc, #off] from the literal at a label
                off = addr[it[2]] - (pc + 8); assert 0 <= off < 4096
                out += struct.pack('<I', 0xE59F0000 | (it[1] << 12) | off)
            elif k == 'lit':                        # .word target - (address of the 'add rX, pc, rX' + 8)
                out += struct.pack('<I', (it[1] - (addr[it[2]] + 8)) & 0xFFFFFFFF)
            pc += 4
        return out, addr

    producer = [
        ('label', 'W_IDR'), ('w', 0xE3A01001), ('b', AL, 'W_COMMON'),              # mov r1, #1 ; b
        ('label', 'W_P'), ('w', 0xE3A01000),                                       # mov r1, #0
        ('label', 'W_COMMON'), ('w', 0xE92D4070), ('w', 0xE1A04000), ('w', 0xE1A05001),  # push {r4-r6,lr}; r4=node; r5=is_idr
        ('ldrpc', 3, 'LIT_G'), ('label', 'ADD_G'), ('w', 0xE08F3003), ('w', 0xE5933004),  # r3 = g
        ('w', 0xE593204C), ('w', 0xE3520000), ('b', EQ, 'FREE_RET'),               # no page -> free
        ('w', 0xE593230C), ('w', 0xE3520000), ('b', EQ, 'ENQ'),                    # no phone session (g+0x30c): the
                                                                                   #  adapter's own menu stream; a key-frame
                                                                                   #  request stops it, so never bound it
        ('w', 0xE5932260), ('w', 0xE3A06000),                                      # r2 = head; r6 = 0
        ('label', 'CNT'), ('w', 0xE3520000), ('b', EQ, 'CNTD'), ('w', 0xE2866001),
        ('w', 0xE356000A), ('w', 0x35922004), ('b', LO, 'CNT'),                    # count up to the limit
        ('label', 'CNTD'), ('ldrpc', 12, 'LIT_F'), ('label', 'ADD_F'), ('w', 0xE08FC00C),  # r12 = &FLAG
        ('w', 0xE59C2000), ('w', 0xE3520000), ('b', EQ, 'NORMAL'),                 # FLAG == 0 -> normal
        ('w', 0xE3550000), ('b', EQ, 'DROP_MORE'),                                 # dropping: non-IDR -> drop
        ('w', 0xE3A02000), ('w', 0xE58C2000), ('b', AL, 'ENQ'),                    # IDR -> FLAG = 0, enqueue
        ('label', 'DROP_MORE'), ('w', 0xE2822001), ('w', 0xE58C2000),              # FLAG++
        ('w', 0xE312003F), ('b', NE, 'FREE_RET'),                                  # every 64 drops:
        ('w', 0xE3A02001), ('w', 0xE58C2000), ('b', AL, 'FREE_RET'),               #   FLAG = 1 (ask again)
        ('label', 'NORMAL'), ('w', 0xE356000A), ('b', LO, 'ENQ'),                  # fewer than the limit -> enqueue
        ('w', 0xE3A02001), ('w', 0xE58C2000),                                      # FLAG = 1 (start dropping)
        ('label', 'FREE_RET'), ('w', 0xE1A00004), ('bl', FREE_PLT), ('w', 0xE8BD8070),  # free(node); return
        ('label', 'ENQ'), ('w', 0xE1A00004), ('w', 0xE8BD4070), ('b', AL, ENQUEUE),     # enqueue (tail call)
        ('label', 'LIT_G'), ('lit', G_REF, 'ADD_G'),
        ('label', 'LIT_F'), ('lit', FLAG_VA, 'ADD_F'),
    ]
    wrapper, waddr = build(code_va, producer)
    hook_va = code_va + len(wrapper)
    consumer = [
        ('label', 'H'), ('w', 0xE92D4010), ('bl', LWS_ON_WRITABLE_PLT),            # push {r4,lr}; the original call
        ('ldrpc', 3, 'LIT_F2'), ('label', 'ADD_F2'), ('w', 0xE08F3003),            # r3 = &FLAG
        ('w', 0xE5932000), ('w', 0xE3520001), ('w', 0x18BD8010),                   # FLAG != 1 -> return
        ('w', 0xE3A02002), ('w', 0xE5832000),                                      # FLAG = 2
        ('w', 0xE3A00C06), ('w', 0xE3A01000), ('bl', LYLINKAPI_KEY_PLT),           # lylinkapi_key(0x600, 0)
        ('w', 0xE3A00C06), ('w', 0xE3A01001), ('bl', LYLINKAPI_KEY_PLT),           # lylinkapi_key(0x600, 1)
        ('w', 0xE8BD8010),                                                         # return
        ('label', 'LIT_F2'), ('lit', FLAG_VA, 'ADD_F2'),
    ]
    # The key-frame request can be issued from the lws thread in two places (T2C_HOOK):
    #   loop (default): wrapper around the main loop's lws_service() call at 0x1a868 — outside any callback
    #   writeable:      at the end of the WRITEABLE callback (0x18cbc) — 26101528, broke the page handshake
    #   none:           no request (bisect)
    hook_mode = os.environ.get('T2C_HOOK', 'loop')
    loop_hook = [
        ('label', 'H2'), ('w', 0xE92D4010), ('bl', LWS_SERVICE_PLT),               # push {r4,lr}; lws_service(ctx, ...)
        ('w', 0xE1A04000),                                                         # r4 = its return value
        ('ldrpc', 3, 'LIT_F3'), ('label', 'ADD_F3'), ('w', 0xE08F3003),            # r3 = &FLAG
        ('w', 0xE5932000), ('w', 0xE3520001), ('b', NE, 'OUT2'),                   # FLAG != 1 -> out
        ('w', 0xE3A02002), ('w', 0xE5832000),                                      # FLAG = 2
        ('w', 0xE3A00C06), ('w', 0xE3A01000), ('bl', LYLINKAPI_KEY_PLT),           # lylinkapi_key(0x600, 0)
        ('w', 0xE3A00C06), ('w', 0xE3A01001), ('bl', LYLINKAPI_KEY_PLT),           # lylinkapi_key(0x600, 1)
        ('label', 'OUT2'), ('w', 0xE1A00004), ('w', 0xE8BD8010),                   # r0 = r4; return
        ('label', 'LIT_F3'), ('lit', FLAG_VA, 'ADD_F3'),
    ]
    hook, haddr = build(hook_va, consumer if hook_mode == 'writeable' else loop_hook)
    # 12. CLOSED of the current page (callback_tsl 0x19618..0x19664): keep the CarPlay session while a
    #     phone is attached; without one behave like stock (lylinkapi_cmd(2) stops the menu stream).
    # 14. page cmd VIDEO (0x181e8..0x18290): no "untake" (lylinkapi_cmd(3)) while the stream already
    #     runs (link == 2); the key-frame request that follows is all the page needs.
    extra_va = hook_va + len(hook)
    extra_prog = [
        ('label', 'A'), ('ldrpc', 3, 'LIT_GA'), ('label', 'ADD_GA'), ('w', 0xE08F3003), ('w', 0xE5933004),  # r3 = g
        ('w', 0xE593330C), ('w', 0xE3530000), ('w', 0x112FFF1E),            # ldr r3, [g+0x30c]; cmp r3, #0; bxne lr
        ('w', 0xE3A00002), ('b', AL, LYLINKAPI_CMD_PLT),                      # mov r0, #2; b lylinkapi_cmd (tail)
        ('label', 'C'), ('ldrpc', 3, 'LIT_GC'), ('label', 'ADD_GC'), ('w', 0xE08F3003), ('w', 0xE5933004),  # r3 = g
        ('w', 0xE5933000), ('w', 0xE3530002), ('w', 0x012FFF1E),            # ldr r3, [g]; cmp r3, #2; bxeq lr
        ('b', AL, LYLINKAPI_CMD_PLT),                                        # b lylinkapi_cmd (r0 = 3 from the caller)
        ('label', 'LIT_GA'), ('lit', G_REF, 'ADD_GA'),
        ('label', 'LIT_GC'), ('lit', G_REF, 'ADD_GC'),
    ]
    extra, xaddr = build(extra_va, extra_prog)
    end = extra_va + len(extra) - TEXT_VA
    assert not any(data[TEXT_SZ:end]) and end < DATA_OFF
    put(NAMES_VA, names)
    put(code_va, wrapper)
    put(hook_va, hook)
    put(extra_va, extra)
    put(0x1965c, bl_insn(0x1965c, xaddr['A']), expect=struct.pack('<I', 0xE3A00002))         # was: mov r0, #2
    put(0x19660, MOV_R0_R0, expect=bl_insn(0x19660, LYLINKAPI_CMD_PLT))                        # was: bl lylinkapi_cmd
    put(0x18214, dp(AL, CMP, 1, 2, 0, 1), expect=dp(AL, CMP, 1, 2, 0, 0))                      # link == 1 (was != 0) ...
    put(0x18218, struct.pack('<I', 0x03A02003), expect=struct.pack('<I', 0x13A02003))         #   moveq r2, #3 (was movne)
    put(0x1821c, struct.pack('<I', 0x05832000), expect=struct.pack('<I', 0x15832000))         #   streq r2, [r3] (was strne)
    put(0x1825c, bl_insn(0x1825c, xaddr['C']), expect=bl_insn(0x1825c, LYLINKAPI_CMD_PLT))    # untake through the cave
    # 13. ly_misc_thread (0x1665c): `cmp r7, #1; bne back` -> always back: the AP never goes to sleep
    put(0x16660, b_insn(AL, 0x16660, 0x163ec), expect=b_insn(NE, 0x16660, 0x163ec))
    put(0x1325c, bl_insn(0x1325c, waddr['W_IDR']), expect=bl_insn(0x1325c, ENQUEUE))
    put(0x132c8, bl_insn(0x132c8, waddr['W_P']), expect=bl_insn(0x132c8, ENQUEUE))
    if hook_mode == 'writeable':
        put(0x18cbc, bl_insn(0x18cbc, haddr['H']), expect=bl_insn(0x18cbc, LWS_ON_WRITABLE_PLT))
    elif hook_mode == 'loop':
        put(0x1a868, bl_insn(0x1a868, haddr['H2']), expect=bl_insn(0x1a868, LWS_SERVICE_PLT))
    put(TEXT_VA + 0xb4 + 20, struct.pack('<I', 0x8a0), expect=struct.pack('<I', 0x89c))   # rw PT_LOAD memsz: FLAG word
    put(TEXT_VA + TEXT_PHDR + 16, struct.pack('<II', end, end), expect=struct.pack('<II', TEXT_SZ, TEXT_SZ))
    # 6. table entries 2 and 5 (duplicates of tespush.com / www.tespush.com) -> the new names
    put(TABLE + 2 * 8, struct.pack('<II', NAMES_VA, len(CARPLAY)), expect=struct.pack('<II', 0x2b781, 13))
    put(TABLE + 5 * 8, struct.pack('<II', NAMES_VA + len(CARPLAY), len(SETTING)), expect=struct.pack('<II', 0x2b7a0, 17))

    # 8. video hand-off (func_14150): with no WebSocket client attached (g+0x268 == 0) the stock code
    #    unlocked and returned without freeing the freshly malloc'd access unit, leaking the whole
    #    stream while the phone kept sending (OOM kill of lylinkui every few minutes once the car page
    #    is gone). Take the "video off" path instead: free(node), then the loop returns at once.
    put(0x141ac, b_insn(EQ, 0x141ac, 0x141bc), expect=b_insn(EQ, 0x141ac, 0x141e8))

    # 9. same function: when the stream is active (g+0x268 != 0) but no page asked for video
    #    (g+0x50 == 0) the stock code frees the unit and then BLOCKS the IPC thread on the condvar
    #    until a page asks or the stream stops. Meanwhile the IPC layer keeps queueing the phone's
    #    units inside this process, which is the 0.3-0.5 MB/s growth that ends in an OOM kill while
    #    the phone streams with no car page attached. Never wait: free and return (frames dropped).
    put(0x141e4, struct.pack('<I', 0xe1a00000), expect=b_insn(NE, 0x141e4, 0x14208))

    # 7. one WebSocket message per access unit (see the module docstring). Was suspected of a memory
    #    leak on 2026-10-16; that turned out to be the no-page leak fixed by patch 10 (the phone starts
    #    streaming at boot before any page attaches). T2C_WS_PATCH=0 builds without it.
    ws_patch = os.environ.get('T2C_WS_PATCH', '1') != '0'   # default on since 26101526; T2C_WS_PATCH=0 disables
    expected = PATCHED_SHA256_WS if ws_patch else PATCHED_SHA256
    if ws_patch:
      put(0x1376c, dp(AL, CMP, 1, 3, 0, 0x10000), expect=dp(AL, CMP, 1, 3, 0, 8192))   # lylws_write: size limit
      put(0x18f8c, movw(AL, 3, FRAG), expect=movw(AL, 3, 0x1fe8))                      # 101/102 message length
      put(0x18f9c, dp(AL, SUB, 0, 2, 2, 0xfe00), expect=dp(AL, SUB, 0, 2, 2, 8128))    # left after the first:
      put(0x18fa0, dp(AL, SUB, 0, 2, 2, 0xfc), expect=dp(AL, SUB, 0, 2, 2, 36))        #   total - (FRAG - 4)
      put(0x19010, dp(AL, ADD, 0, 2, 2, 0x10000), expect=dp(AL, ADD, 0, 2, 2, 8192))   # type 100 up to total 65508
      put(0x19034, dp(AL, SUB, 0, 2, 2, FRAG), expect=dp(AL, SUB, 0, 2, 2, 8128))      # left after a middle one:
      put(0x19040, dp(AL, SUB, 0, 2, 2, 0), expect=dp(AL, SUB, 0, 2, 2, 40))           #   remaining - FRAG
      put(TSL_TX_PACKET_SIZE, struct.pack('<I', 0x10000), expect=struct.pack('<I', 0))  # one send() per message

    out = hashlib.sha256(data).hexdigest()
    if os.environ.get('T2C_HOOK', 'loop') != 'loop': expected = out   # variants: no fixed hash
    if out != expected:
        sys.exit('patched sha256 %s does not match the expected %s' % (out, expected))
    open(path, 'r+b').write(bytes(data))
    print('lylinkui patched: dnsd answers carplay.internal and setting.internal, session survives the page, no AP sleep%s (%s)'
          % ('; one WebSocket message per access unit' if ws_patch else '', out[:16]))


ORIGINAL_SHA256 = '37ce2c3a412545cb1e0cbb28c87ec6a8a7558332b99e20ab9f88a6c794e11e98'
PATCHED_SHA256 = '8ae4e3bc41b8e22a9878942f77ab6717c7b3ff7ea7e5fb9b836917358329c868'      # patches 1-6, 8, 9, 10/11 (loop hook), 12-14
PATCHED_SHA256_WS = 'bbbcebea0b2227b6fcd254b81dfaa8d264c391cbc983d4c2fb77ebeb12f193a2'   # + patch 7 (T2C_WS_PATCH=1)

if __name__ == '__main__':
    main()
