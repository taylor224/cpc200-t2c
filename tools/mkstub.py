#!/usr/bin/env python3
"""Import-only stub of a shared library whose file has no section headers (the adapter's musl
libc.so and libgcc_s.so.1 were sstrip'ed, lld refuses them as link inputs). Reads the dynamic
segment, emits one empty global symbol per exported FUNC/OBJECT, and the caller assembles it into
a .so with the right SONAME. The result links like the real library and has exactly its symbol
set, so a Rust binary that uses something the device does not have fails at link time, not at
load time. Used by tools/mksysroot.sh.

    tools/mkstub.py LIB.so > stub.s
"""
import struct
import sys

DT_HASH, DT_STRTAB, DT_SYMTAB, DT_STRSZ, DT_SONAME, DT_GNU_HASH = 4, 5, 6, 10, 14, 0x6FFFFEF5


def main():
    data = open(sys.argv[1], "rb").read()
    (e_phoff,) = struct.unpack_from("<I", data, 0x1C)
    e_phentsize, e_phnum = struct.unpack_from("<HH", data, 0x2A)
    segs, dyn = [], None
    for i in range(e_phnum):
        p_type, p_offset, p_vaddr, _pa, p_filesz = struct.unpack_from("<IIIII", data, e_phoff + i * e_phentsize)
        if p_type == 1:
            segs.append((p_vaddr, p_offset, p_filesz))
        elif p_type == 2:
            dyn = (p_offset, p_filesz)

    def v2o(v):
        for va, off, fsz in segs:
            if va <= v < va + fsz:
                return v - va + off
        raise KeyError(hex(v))

    tags = {}
    off, end = dyn[0], dyn[0] + dyn[1]
    while off < end:
        tag, val = struct.unpack_from("<Ii", data, off)
        if tag == 0:
            break
        tags.setdefault(tag, val & 0xFFFFFFFF)
        off += 8
    strtab, symtab = v2o(tags[DT_STRTAB]), v2o(tags[DT_SYMTAB])
    if DT_HASH in tags:
        nsyms = struct.unpack_from("<I", data, v2o(tags[DT_HASH]) + 4)[0]
    else:  # GNU hash: walk the chains for the highest symbol index
        h = v2o(tags[DT_GNU_HASH])
        nbuckets, symoffset, bloom_size, _shift = struct.unpack_from("<IIII", data, h)
        buckets = h + 16 + bloom_size * 4
        chains = buckets + nbuckets * 4
        nsyms = 0
        for b in range(nbuckets):
            idx = struct.unpack_from("<I", data, buckets + b * 4)[0]
            if idx == 0:
                continue
            while True:
                c = struct.unpack_from("<I", data, chains + (idx - symoffset) * 4)[0]
                nsyms = max(nsyms, idx + 1)
                if c & 1:
                    break
                idx += 1

    def cstr(o):
        return data[o : data.index(b"\0", o)].decode()

    soname = cstr(strtab + tags[DT_SONAME]) if DT_SONAME in tags else sys.argv[1].rsplit("/", 1)[-1]
    out = ["@ import stub for %s (%d dynamic symbols)" % (soname, nsyms), ".syntax unified", ".text"]
    nf = no = 0
    for i in range(1, nsyms):
        st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack_from("<IIIBBH", data, symtab + i * 16)
        bind, typ = st_info >> 4, st_info & 0xF
        if st_shndx == 0 or bind not in (1, 2) or (st_other & 3) in (1, 2):  # undefined / local / internal+hidden (musl exports PROTECTED)
            continue
        name = cstr(strtab + st_name)
        if typ == 2:  # FUNC
            out += [".globl %s" % name, ".type %s,%%function" % name, "%s: bx lr" % name]
            nf += 1
        elif typ == 1 and st_size > 0:  # OBJECT
            out += [".data", ".globl %s" % name, ".type %s,%%object" % name, ".size %s,%d" % (name, st_size), ".balign 4", "%s: .space %d" % (name, st_size), ".text"]
            no += 1
    out.insert(1, "@ %d functions, %d objects" % (nf, no))
    print("\n".join(out))


if __name__ == "__main__":
    main()
