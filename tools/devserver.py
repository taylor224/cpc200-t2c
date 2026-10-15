#!/usr/bin/env python3
"""Local simulator of the T2C adapter's web interface (lylinkui) for UI development.

Serves src/www exactly like the adapter does (index.in -> index.html templating),
speaks the "tsl" WebSocket protocol with canned data, streams MJPEG at /video.jpg
from a directory of JPEG frames, and can push an Annex-B H.264 stream in video mode.

Usage:
  devserver.py [--www src/www] [--frames DIR] [--h264 FILE] [--port 8765]
               [--link-after SEC] [--mode picture|video] [--lan N] [--no-cell] [--no-keyframes]

Standard library only. Not part of the firmware.
"""
import argparse, base64, hashlib, http.server, json, os, socketserver, struct, sys, threading, time, glob, urllib.parse

ARGS = None
STATE = {
    'link': 0, 'phone': False, 'pong': 0,
    'cfg': {'auto': True, 'night': 0, 'pixel': 3, 'driver': 0, 'fps': 0, 'vid': False, 'lan': 3,
            'btnet': False, 'online': True, 'ch': 36, 'sh': 36, 'icon': '', 'name': ''},
    'override': None, 'clients': set(), 'current': None, 'bt': 'TesPush_T2C-7F3A', 'btconn': None,
    'paired': ['1AABBCCDDEE01Taylor iPhone', '1112233445566Guest iPhone'],
}
LOCK = threading.Lock()


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


# --------------------------------------------------------------- templating
def render_index(www):
    """Mimic lylinkui: replace |NNN tokens using lan/<n>.txt (only last two digits used)."""
    lan = STATE['cfg']['lan']
    if lan > 2:
        lan = 2
    try:
        lines = open(os.path.join(www, 'lan', '%d.txt' % lan), encoding='utf-8').read().split('\n')
    except OSError:
        lines = []
    src = open(os.path.join(www, 'index.in'), encoding='utf-8').read()
    out = []
    i = 0
    while True:
        j = src.find('|', i)
        if j < 0:
            out.append(src[i:])
            break
        out.append(src[i:j])
        try:
            idx = (ord(src[j + 2]) - 48) * 10 + (ord(src[j + 3]) - 48)
            out.append(lines[idx] if 0 <= idx < len(lines) else '')
        except IndexError:
            out.append('')
        i = j + 4
    return ''.join(out).encode('utf-8')


# -------------------------------------------------------------- websocket
GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def ws_frame(opcode, payload):
    hdr = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        hdr.append(n)
    elif n < 65536:
        hdr += struct.pack('>BH', 126, n)
    else:
        hdr += struct.pack('>BQ', 127, n)
    return bytes(hdr) + payload


def ws_read(rfile):
    h = rfile.read(2)
    if len(h) < 2:
        return None, None
    fin_op, ml = h
    op = fin_op & 0x0f
    masked = ml & 0x80
    n = ml & 0x7f
    if n == 126:
        n = struct.unpack('>H', rfile.read(2))[0]
    elif n == 127:
        n = struct.unpack('>Q', rfile.read(8))[0]
    mask = rfile.read(4) if masked else None
    data = bytearray(rfile.read(n))
    if mask:
        for i in range(n):
            data[i] ^= mask[i % 4]
    return op, bytes(data)


def msg(type_, payload):
    if isinstance(payload, (dict, list)):
        payload = json.dumps(payload).encode()
    return ws_frame(2, struct.pack('<II', len(payload), type_) + payload)


class Client:
    def __init__(self, wfile):
        self.wfile = wfile
        self.lock = threading.Lock()
        self.alive = True
        self.hello = None

    def send(self, frame):
        with self.lock:
            try:
                self.wfile.write(frame)
                self.wfile.flush()
            except OSError:
                self.alive = False


def init_json():
    c = STATE['cfg']
    hw = 'T2C-CA-A1_V2.1-A1' if not ARGS.no_cell else 'T2C'
    md = 'TesPush-T2C'
    return {
        'link': STATE['link'], 'phone': STATE['phone'], 'bt': STATE['bt'], 'auto': c['auto'],
        'ssid': 'TesPush_T2C_7F3A', 'psk': '88888888', 'ch': c['ch'], 'sh': c['sh'],
        'night': c['night'], 'pixel': c['pixel'], 'driver': c['driver'], 'fps': c['fps'], 'vid': c['vid'],
        'icons': {'tsl0': 'Tesla', 'tsl1': 'Tesla', 'sr00': 'Siri', 'sr01': 'Siri'}, 'icon': c['icon'],
        'name': c['name'], 'lan': c['lan'], 'SN': 'TesPush_T2C', 'SW': '26090414.5.4', 'LY': '26090414.1508.1',
        'HW': hw, 'MD': md, 'imei': '860000000000000', 'ccid': '89860000000000000000',
        'btnet': c['btnet'], 'wifi': 'a1b2c3d4e5f6', 'bl': 0, 'online': c['online'],
    }


def broadcast(frame):
    with LOCK:
        cl = list(STATE['clients'])
    for c in cl:
        c.send(frame)


def set_link(v):
    STATE['link'] = v
    broadcast(msg(3, {'link': v, 'phone': STATE['phone']}))
    log('link ->', v)


def status_loop():
    n = 0
    while True:
        time.sleep(1)
        n += 1
        j = {'sys': 12, 'exe': 3, 'apn': 'internet' if not ARGS.no_cell else '', 'sig': (n // 3) % 6,
             'csq': 18 if n % 10 else 0, 'bt': STATE['btconn'] or '', 'pong': 0}
        # Like lylinkui: status (and with it the pong) only goes to the newest connection.
        c = STATE['current']
        if c is not None and c.alive:
            j['pong'] = c.pong
            c.send(msg(0, j))


def h264_loop():
    """Push Annex-B access units (type 100) while in video mode and link > 1."""
    if not ARGS.h264:
        return
    data = open(ARGS.h264, 'rb').read()
    # Split the Annex-B stream into access units: NAL units start with 00 00 01 (or
    # 00 00 00 01); a VCL NAL with first_mb_in_slice == 0 begins a new picture.
    starts = []
    i = 0
    while True:
        j = data.find(b'\x00\x00\x01', i)
        if j < 0:
            break
        starts.append(j + 3)
        i = j + 3
    nals = []
    for n, st in enumerate(starts):
        end = starts[n + 1] - 3 if n + 1 < len(starts) else len(data)
        if end > st and data[end - 1] == 0:   # 4-byte start code of the next NAL
            end -= 1
        nals.append(data[st:end])
    frames = []
    acc = b''
    has_vcl = False
    for u in nals:
        t = u[0] & 0x1f
        vcl = t in (1, 2, 3, 4, 5)
        first_mb0 = vcl and len(u) > 1 and (u[1] & 0x80) != 0
        if vcl and has_vcl and first_mb0:
            frames.append(acc)
            acc = b''
            has_vcl = False
        acc += b'\x00\x00\x00\x01' + u
        if vcl:
            has_vcl = True
    if acc:
        frames.append(acc)
    log('h264 mock: %d access units' % len(frames))
    k = 0
    n = 0
    while True:
        if STATE['link'] > 1 and STATE['cfg']['vid']:
            if STATE.pop('keyreq', False):
                k = 0          # key frame requested (cmd 8): restart from the IDR
            n += 1
            burst = ARGS.burst if (ARGS.burst and n % 150 == 0) else 1
            for _ in range(burst):
                f = frames[k % len(frames)]
                k += 1
                if len(f) < 60000:
                    broadcast(msg(100, struct.pack('<I', len(f)) + f))
                else:
                    chunks = [f[i:i + 32768] for i in range(0, len(f), 32768)]
                    broadcast(msg(101, struct.pack('<I', len(f)) + chunks[0]))
                    for ch in chunks[1:-1]:
                        broadcast(msg(102, ch))
                    broadcast(msg(103, chunks[-1]))
            if burst > 1:
                log('burst of %d access units' % burst)
            time.sleep(1 / 30)
        else:
            time.sleep(0.2)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):
        if ARGS.verbose:
            log(self.address_string(), fmt % a)

    def send_bytes(self, body, ctype='text/html; charset=utf-8', code=200):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if self.headers.get('Upgrade', '').lower() == 'websocket':
            return self.handle_ws()
        if path == '/video.jpg':
            return self.stream_mjpeg()
        if path == '/tsl/bt':
            return self.send_bytes(json.dumps(STATE['paired']).encode(), 'application/json')
        if path == '/mic_test.pcm':
            import math
            pcm = struct.pack('<%dh' % 8000, *[int(8000 * math.sin(i / 10.0)) for i in range(8000)])
            return self.send_bytes(b'\0' * 2000 + pcm, 'application/octet-stream')
        if path == '/online/status.html':
            return self.send_bytes(b'<html><body>online</body></html>')
        if path == '/':
            path = '/index.html'
        if path == '/index.html':
            return self.send_bytes(render_index(ARGS.www))
        fs = os.path.normpath(os.path.join(ARGS.www, path.lstrip('/')))
        if not fs.startswith(os.path.abspath(ARGS.www)) or not os.path.isfile(fs):
            return self.send_bytes(b'not found', 'text/plain', 404)
        ext = os.path.splitext(fs)[1].lower()
        ctype = {'.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
                 '.svg': 'image/svg+xml', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
                 '.txt': 'text/plain; charset=utf-8'}.get(ext, 'application/octet-stream')
        return self.send_bytes(open(fs, 'rb').read(), ctype)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        n = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(n)
        if path == '/tsl/fw':
            log('firmware upload', len(body), 'bytes')
            self.send_bytes(b'{"ok":1}', 'application/json')
            def fw():
                for v in (1, 2, 1, 2, 3):
                    time.sleep(1)
                    broadcast(msg(4, {'val': v, 'pong': 0}))
            threading.Thread(target=fw, daemon=True).start()
            return
        self.send_bytes(b'nope', 'text/plain', 404)

    # ------------------------------------------------------------ MJPEG
    def stream_mjpeg(self):
        if STATE['cfg']['vid']:
            return self.send_bytes(b'video mode', 'text/plain', 404)
        files = sorted(glob.glob(os.path.join(ARGS.frames, '*.jpg'))) if ARGS.frames else []
        if not files:
            return self.send_bytes(b'no frames', 'text/plain', 404)
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=CarPlayVideo')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        k = 0
        try:
            while True:
                if STATE['link'] > 1:
                    data = open(files[k % len(files)], 'rb').read()
                    k += 1
                    self.wfile.write(b'--CarPlayVideo\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n' % len(data))
                    self.wfile.write(data)
                    self.wfile.flush()
                    time.sleep(1 / ARGS.fps)
                else:
                    time.sleep(0.2)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    # -------------------------------------------------------- WebSocket
    def handle_ws(self):
        key = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        if 'tsl' in self.headers.get('Sec-WebSocket-Protocol', ''):
            self.send_header('Sec-WebSocket-Protocol', 'tsl')
        self.end_headers()
        self.wfile.flush()
        c = Client(self.wfile)
        c.pong = 0
        with LOCK:
            STATE['clients'].add(c)
            STATE['current'] = c
        log('ws client connected')
        try:
            while c.alive:
                op, data = ws_read(self.rfile)
                if op == 8:
                    c.send(ws_frame(8, data[:2]))   # answer the closing handshake
                    break
                if op is None:
                    break
                if op == 9:
                    c.send(ws_frame(10, data))
                    continue
                if op != 2:
                    continue
                self.on_ws(c, data)
        except (OSError, ValueError) as e:
            log('ws error', e)
        finally:
            with LOCK:
                STATE['clients'].discard(c)
                if STATE['current'] is c:
                    STATE['current'] = None
            self.close_connection = True
            log('ws client gone')

    def on_ws(self, c, data):
        if len(data) < 4:
            return
        length, typ = struct.unpack('<HH', data[:4])
        if typ == 12 and len(data) >= 8:   # ping (Uint32 [0x000C0004, n])
            c.pong = struct.unpack('<I', data[4:8])[0]
            return
        if typ == 2:
            w, h = struct.unpack('<HH', data[4:8])
            rest = data[8:].split(b'\0')
            c.hello = {'w': w, 'h': h, 'lang': rest[0].decode(errors='replace'), 'nav': rest[1].decode(errors='replace') if len(rest) > 1 else ''}
            log('hello', c.hello)
            c.send(msg(1, init_json()))
            STATE['hellos'] = STATE.get('hellos', 0) + 1
            if STATE['cfg']['pixel'] == 3 and STATE['link'] >= 1:
                # lylinkui restarts the CarPlay session on every hello in Auto size mode.
                def restart():
                    log('session restart (hello in Auto mode)')
                    set_link(0)
                    time.sleep(1.5)
                    set_link(1)
                    time.sleep(0.5)
                    set_link(2)
                threading.Thread(target=restart, daemon=True).start()
                return
            if ARGS.link_after >= 0 and STATE['link'] == 0:
                def go():
                    STATE['phone'] = True
                    broadcast(msg(3, {'link': 0, 'phone': True}))
                    time.sleep(ARGS.link_after)
                    set_link(1)
                    time.sleep(0.5)
                    set_link(2)
                threading.Thread(target=go, daemon=True).start()
            return
        if typ == 1:
            m, x, y = struct.unpack('<hhh', data[4:10])
            if ARGS.verbose:
                log('touch', m, x, y)
            return
        if typ == 3:
            cmd = struct.unpack('<h', data[4:6])[0]
            log('cmd', cmd)
            if cmd == 0 and STATE['link'] >= 1:
                set_link(2)
            elif cmd == 9:
                c.send(msg(300, b'WIFI:T:WPA;S:TesPush_T2C_7F3A;P:88888888;;'))
            elif cmd == 8:
                if not ARGS.no_keyframes:
                    STATE['keyreq'] = True
            elif cmd == 7:
                log('FACTORY RESET requested')
            elif cmd == 1:
                STATE['cfg']['auto'] = True
            elif cmd == 2:
                STATE['cfg']['auto'] = False
            return
        if typ == 7:
            k, v = struct.unpack('<hh', data[4:8])
            names = {1: 'night', 2: 'pixel', 3: 'driver', 6: 'ch', 7: 'lan', 8: 'btnet', 9: 'fps', 10: 'online', 11: 'vid'}
            name = names.get(k, 'key%d' % k)
            log('setkey', name, v)
            cfg = STATE['cfg']
            if name in ('pixel', 'driver', 'fps') and cfg.get(name) != v and STATE['link'] >= 1:
                # lylinkui restarts the CarPlay session on any change of these.
                def restart_cfg():
                    log('session restart (%s %s -> %s)' % (name, cfg.get(name), v))
                    set_link(0)
                    time.sleep(1.5)
                    set_link(1)
                    time.sleep(0.5)
                    set_link(2)
                threading.Thread(target=restart_cfg, daemon=True).start()
            if name == 'vid':
                cfg['vid'] = bool(v)
            elif name == 'btnet':
                cfg['btnet'] = v == 2
            elif name == 'online':
                cfg['online'] = bool(v)
            elif name == 'lan':
                cfg['lan'] = v if v <= 2 else 3
            elif name in cfg:
                cfg[name] = v
            return
        if typ == 8:
            log('night ->', data[4])
            return
        if typ == 10:
            log('identity', data[4:16].rstrip(b'\0'), data[16:])
            return
        if typ == 11:
            w, h = struct.unpack('<HH', data[4:8])
            STATE['override'] = None if w == 0 else {'w': w, 'h': h, 'mmw': data[8], 'mmh': data[9]}
            log('session override', STATE['override'])
            return
        if typ in (4, 5, 6, 9):
            s = data[4:4 + length].decode(errors='replace')
            log({4: 'bt connect', 5: 'bt disconnect', 6: 'bt forget', 9: 'wifi psk'}[typ], s)
            if typ == 4:
                STATE['btconn'] = s
            elif typ == 5:
                STATE['btconn'] = None
            elif typ == 6:
                STATE['paired'] = [p for p in STATE['paired'] if p[1:13] != s]
                broadcast(msg(2, b''))
            return
        if typ == 13:
            return
        log('unknown type', typ, data[:16])


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument('--www', default=os.path.join(os.path.dirname(__file__), '..', 'src', 'www'))
    p.add_argument('--frames', default='')
    p.add_argument('--h264', default='')
    p.add_argument('--port', type=int, default=8765)
    p.add_argument('--fps', type=float, default=30)
    p.add_argument('--link-after', type=float, default=-1, help='seconds after hello to simulate a phone link (-1 never)')
    p.add_argument('--mode', choices=['picture', 'video'], default='picture')
    p.add_argument('--lan', type=int, default=3)
    p.add_argument('--no-cell', action='store_true')
    p.add_argument('--verbose', action='store_true')
    p.add_argument('--no-keyframes', action='store_true', help='ignore key frame requests (cmd 8), like a slow iPhone')
    p.add_argument('--burst', type=int, default=0, help='every 5 s send N access units at once (decoder falls behind)')
    ARGS = p.parse_args()
    ARGS.www = os.path.abspath(ARGS.www)
    STATE['cfg']['vid'] = ARGS.mode == 'video'
    STATE['cfg']['lan'] = ARGS.lan
    threading.Thread(target=status_loop, daemon=True).start()
    threading.Thread(target=h264_loop, daemon=True).start()
    srv = Server(('127.0.0.1', ARGS.port), Handler)
    log('serving', ARGS.www, 'on http://127.0.0.1:%d/' % ARGS.port)
    srv.serve_forever()


if __name__ == '__main__':
    main()
