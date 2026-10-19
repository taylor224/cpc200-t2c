#!/usr/bin/env python3
"""ELF32 (ARM) symbol helper for the vendor binaries: PLT slot -> imported symbol name, exports,
imports. llvm-objdump on macOS shows PLT calls as `<.plt+0x..>`; this maps them.

    tools/elfsyms.py FILE plt        # "ADDR NAME" per PLT entry (ARM: PLT0 20 bytes, then 12 each)
    tools/elfsyms.py FILE exports    # defined dynamic symbols
    tools/elfsyms.py FILE imports    # undefined dynamic symbols
    tools/elfsyms.py FILE annotate DIS   # rewrite an objdump listing with PLT names
    tools/elfsyms.py FILE logs DIS       # every __android_log_print call: ADDR prio TAG "fmt" func:line
"""
import struct
import sys


def sections(data):
    (e_shoff,) = struct.unpack_from("<I", data, 0x20)
    e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", data, 0x2E)
    secs = []
    for i in range(e_shnum):
        off = e_shoff + i * e_shentsize
        name, typ, flags, addr, offset, size, link, info, align, entsize = struct.unpack_from("<IIIIIIIIII", data, off)
        secs.append(dict(name=name, type=typ, addr=addr, offset=offset, size=size, link=link, info=info, entsize=entsize))
    strtab = secs[e_shstrndx]
    for s in secs:
        end = data.index(b"\0", strtab["offset"] + s["name"])
        s["sname"] = data[strtab["offset"] + s["name"] : end].decode()
    return {s["sname"]: s for s in secs}


def dynsyms(data, secs):
    ds, dstr = secs[".dynsym"], secs[".dynstr"]
    out = []
    for i in range(ds["size"] // 16):
        name, value, size, info, other, shndx = struct.unpack_from("<IIIBBH", data, ds["offset"] + i * 16)
        end = data.index(b"\0", dstr["offset"] + name)
        out.append(dict(name=data[dstr["offset"] + name : end].decode(), value=value, size=size, shndx=shndx, type=info & 0xF))
    return out


def plt_map(data, secs, syms):
    rel = secs.get(".rel.plt")
    plt = secs.get(".plt")
    if not rel or not plt:
        return []
    out = []
    n = rel["size"] // 8
    for i in range(n):
        r_offset, r_info = struct.unpack_from("<II", data, rel["offset"] + i * 8)
        sym = syms[r_info >> 8]
        out.append((plt["addr"] + 20 + 12 * i, sym["name"]))
    return out


def segments(data):
    (e_phoff,) = struct.unpack_from("<I", data, 0x1C)
    e_phentsize, e_phnum = struct.unpack_from("<HH", data, 0x2A)
    segs = []
    for i in range(e_phnum):
        p_type, p_offset, p_vaddr, _pa, p_filesz = struct.unpack_from("<IIIII", data, e_phoff + i * e_phentsize)
        if p_type == 1:
            segs.append((p_vaddr, p_offset, p_filesz))
    return segs


def logs(data, listing):
    """Resolve the arguments of each __android_log_print call in an objdump listing. The vendor code
    always builds them the same way: `ldr rX, [pc, #k] @ LIT` + `add rX, pc, rX` (+ `add rX, rX, #n`)
    for the strings, `mov/movw r3, #line` + `str r3, [sp]` for the line number, `mov r0, #prio`."""
    import re

    segs = segments(data)

    def v2o(v):
        for va, off, fsz in segs:
            if va <= v < va + fsz:
                return v - va + off
        return None

    def u32(v):
        o = v2o(v)
        return struct.unpack_from("<I", data, o)[0] if o is not None else None

    def cstr(v):
        o = v2o(v)
        if o is None:
            return None
        end = data.find(b"\0", o, o + 400)
        if end < 0:
            return None
        return data[o:end].decode("latin1")

    ins = []
    for line in listing:
        m = re.match(r"\s*([0-9a-f]+):\s+[0-9a-f]{8}\s+(\S+)\s*(.*)", line)
        if m:
            ins.append((int(m.group(1), 16), m.group(2), m.group(3)))
    out = []
    for i, (addr, mn, ops) in enumerate(ins):
        if not (mn == "bl" and "__android_log_print@plt" in ops):
            continue
        regs = {}
        pending = {}  # reg -> (addr_of_add_pc, extra)
        line_reg, line_no, prio = None, None, None
        for j in range(i - 1, max(-1, i - 60), -1):
            a, m2, o = ins[j]
            if m2 in ("push", "pop", "bx") or (m2 == "bl" and "__android_log_print" in o):
                break
            mm = re.match(r"(r\d+), (r\d+), #(\d+)$", o)
            if m2 == "add" and mm and mm.group(1) == mm.group(2) and mm.group(1) not in regs:
                r = mm.group(1)
                pending.setdefault(r, [None, 0])
                pending[r][1] += int(mm.group(3))
                continue
            mm = re.match(r"(r\d+), pc, (r\d+)$", o)
            if m2 == "add" and mm and mm.group(1) == mm.group(2) and mm.group(1) not in regs:
                r = mm.group(1)
                pending.setdefault(r, [None, 0])
                pending[r][0] = a + 8
                continue
            mm = re.match(r"(r\d+), \[pc, #0x[0-9a-f]+\]\s+@ 0x([0-9a-f]+)", o)
            if m2 == "ldr" and mm and mm.group(1) in pending and pending[mm.group(1)][0] is not None and mm.group(1) not in regs:
                r = mm.group(1)
                lit = u32(int(mm.group(2), 16))
                if lit is not None:
                    regs[r] = pending[r][0] + lit + pending[r][1]
                continue
            mm = re.match(r"(r\d+), \[sp\]$", o)
            if m2 == "str" and mm and line_reg is None:
                line_reg = mm.group(1)
                continue
            mm = re.match(r"(r\d+), #(0x[0-9a-f]+|\d+)$", o)
            if m2 in ("mov", "movw") and mm:
                if mm.group(1) == line_reg and line_no is None:
                    line_no = int(mm.group(2), 0)
                elif mm.group(1) == "r0" and prio is None:
                    prio = int(mm.group(2), 0)
        tag = cstr(regs["r1"]) if "r1" in regs else "?"
        fmt = cstr(regs["r2"]) if "r2" in regs else "?"
        func = cstr(regs["r3"]) if "r3" in regs else "?"
        out.append("%08x %s %-8s %s|%s %r" % (addr, "VDIWEF"[prio - 2] if prio and 2 <= prio <= 7 else "?", tag, func, line_no if line_no is not None else "?", fmt))
    return out


def main():
    path, mode = sys.argv[1], sys.argv[2]
    data = open(path, "rb").read()
    secs = sections(data)
    syms = dynsyms(data, secs)
    if mode == "logs":
        for line in logs(data, open(sys.argv[3]).read().split("\n")):
            print(line)
        return
    if mode == "plt":
        for addr, name in plt_map(data, secs, syms):
            print("%08x %s" % (addr, name))
    elif mode == "exports":
        for s in syms:
            if s["shndx"] != 0 and s["name"]:
                print("%08x %s" % (s["value"], s["name"]))
    elif mode == "imports":
        for s in syms:
            if s["shndx"] == 0 and s["name"]:
                print(s["name"])
    elif mode == "annotate":
        m = {addr: name for addr, name in plt_map(data, secs, syms)}
        for line in open(sys.argv[3]):
            out = line.rstrip("\n")
            # "bl 0x18f0 <.plt+0x3e0>" -> "bl 0x18f0 <lylinkapi_touch@plt>"
            import re
            def fix(mo):
                a = int(mo.group(1), 16)
                return "0x%x <%s@plt>" % (a, m[a]) if a in m else mo.group(0)
            out = re.sub(r"0x([0-9a-f]+) <\.plt\+0x[0-9a-f]+>", fix, out)
            print(out)


if __name__ == "__main__":
    main()
