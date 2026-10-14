#!/usr/bin/env python3
"""Unpack / repack Carlinkit .img (md5 line + SWUpdate newc CPIO with CRC)."""
import sys, os, struct, hashlib, json

def rd_hdr(b, o):
    assert b[o:o+6] == b'070702', ("bad magic at", o, b[o:o+6])
    f = [int(b[o+6+i*8:o+14+i*8], 16) for i in range(13)]
    (ino, mode, uid, gid, nlink, mtime, fsize, devmaj, devmin, rdevmaj, rdevmin, namesize, chk) = f
    name = b[o+110:o+110+namesize-1].decode()
    doff = (o + 110 + namesize + 3) & ~3
    return dict(ino=ino, mode=mode, uid=uid, gid=gid, nlink=nlink, mtime=mtime, fsize=fsize,
                devmaj=devmaj, devmin=devmin, rdevmaj=rdevmaj, rdevmin=rdevmin, name=name, chk=chk,
                doff=doff, next=(doff + fsize + 3) & ~3)

def unpack(img, out):
    b = open(img, 'rb').read()
    nl = b.index(b'\n')
    line = b[:nl].decode()
    md5, fname = line.split()
    body = b[nl+1:]
    print("header:", line, "body md5", hashlib.md5(body).hexdigest(), "ok" if hashlib.md5(body).hexdigest()==md5 else "MISMATCH")
    os.makedirs(out, exist_ok=True)
    o = 0; meta = []
    while True:
        h = rd_hdr(body, o)
        if h['name'] == 'TRAILER!!!':
            print("trailer at", o, "remaining", len(body)-h['next'])
            break
        data = body[h['doff']:h['doff']+h['fsize']]
        c = sum(data) & 0xffffffff
        print(f"{h['name']:20s} size={h['fsize']:9d} mode={h['mode']:o} chk={'ok' if c==h['chk'] else 'BAD'}")
        open(os.path.join(out, h['name']), 'wb').write(data)
        meta.append({k: h[k] for k in ('ino','mode','uid','gid','nlink','mtime','devmaj','devmin','rdevmaj','rdevmin','name')})
        o = h['next']
    json.dump({'fname': fname, 'entries': meta}, open(os.path.join(out, '_meta.json'), 'w'), indent=1)

def pack(dirn, img):
    meta = json.load(open(os.path.join(dirn, '_meta.json')))
    out = bytearray()
    for e in meta['entries']:
        data = open(os.path.join(dirn, e['name']), 'rb').read()
        name = e['name'].encode() + b'\0'
        chk = sum(data) & 0xffffffff
        f = [e['ino'], e['mode'], e['uid'], e['gid'], e['nlink'], e['mtime'], len(data), e['devmaj'], e['devmin'], e['rdevmaj'], e['rdevmin'], len(name), chk]
        hdr = b'070702' + ''.join('%08X' % x for x in f).encode()
        out += hdr + name
        while len(out) % 4: out += b'\0'
        out += data
        while len(out) % 4: out += b'\0'
    name = b'TRAILER!!!\0'
    f = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, len(name), 0]
    out += b'070702' + ''.join('%08X' % x for x in f).encode() + name
    while len(out) % 4: out += b'\0'
    while len(out) % 512: out += b'\0'   # cpio block padding, as in the official image
    body = bytes(out)
    hdr = f"{hashlib.md5(body).hexdigest()}  {meta['fname']}\n".encode()
    open(img, 'wb').write(hdr + body)
    print("wrote", img, len(hdr)+len(body))

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'unpack': unpack(sys.argv[2], sys.argv[3])
    elif cmd == 'pack': pack(sys.argv[2], sys.argv[3])
