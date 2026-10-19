#!/usr/bin/env python3
"""Tiny Chrome DevTools Protocol driver (standard library only) for UI testing.

Launch a headless Chrome yourself, e.g.
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
     --remote-debugging-port=9333 --user-data-dir=/tmp/t2c-chrome --no-first-run about:blank

Then run steps in order, e.g.
  tools/cdp.py --port 9333 --metrics 773x601x1.53 --goto http://127.0.0.1:8791/ --wait 2 \
      --shot /tmp/home.png --eval "document.title" --wait 5 --shot /tmp/stage.png --console

Steps: --metrics WxHxDPR | --goto URL | --wait SEC | --shot FILE | --eval JS | --tap X,Y
       | --click X,Y | --drag X1,Y1,X2,Y2,MS | --console | --reload | --cdp METHOD JSON
"""
import base64, json, os, socket, struct, sys, time, urllib.request, random


class WS:
    def __init__(self, url):
        assert url.startswith('ws://')
        hostport, path = url[5:].split('/', 1)
        host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)))
        key = base64.b64encode(os.urandom(16)).decode()
        req = ('GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n' % (path, hostport, key))
        self.s.sendall(req.encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        assert b' 101 ' in buf.split(b'\r\n')[0], buf
        self.rest = buf.split(b'\r\n\r\n', 1)[1]

    def _read(self, n):
        while len(self.rest) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise EOFError
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, text):
        data = text.encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr += struct.pack('>BH', 0x80 | 126, n)
        else:
            hdr += struct.pack('>BQ', 0x80 | 127, n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.s.sendall(bytes(hdr) + mask + masked)

    def recv(self):
        h = self._read(2)
        op = h[0] & 0x0f
        n = h[1] & 0x7f
        if n == 126:
            n = struct.unpack('>H', self._read(2))[0]
        elif n == 127:
            n = struct.unpack('>Q', self._read(8))[0]
        data = self._read(n)
        if op == 1:
            return data.decode()
        return None


class CDP:
    def __init__(self, port):
        self.port = port
        req = urllib.request.Request('http://127.0.0.1:%d/json/new?about:blank' % port, method='PUT')
        info = json.load(urllib.request.urlopen(req))
        self.target = info['id']
        self.ws = WS(info['webSocketDebuggerUrl'])
        self.id = 0
        self.events = []
        self.console = []
        for m in ('Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'):
            self.call(m)

    def call(self, method, **params):
        self.id += 1
        mid = self.id
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
        while True:
            m = self.ws.recv()
            if m is None:
                continue
            j = json.loads(m)
            if j.get('id') == mid:
                if 'error' in j:
                    raise RuntimeError(json.dumps(j['error']))
                return j.get('result', {})
            self.on_event(j)

    def on_event(self, j):
        meth = j.get('method', '')
        if meth == 'Runtime.consoleAPICalled':
            args = [a.get('value', a.get('description', '')) for a in j['params'].get('args', [])]
            self.console.append('[%s] %s' % (j['params']['type'], ' '.join(str(a) for a in args)))
        elif meth == 'Runtime.exceptionThrown':
            d = j['params']['exceptionDetails']
            self.console.append('[exception] %s %s' % (d.get('text'), (d.get('exception') or {}).get('description', '')))
        elif meth == 'Log.entryAdded':
            e = j['params']['entry']
            self.console.append('[%s/%s] %s %s' % (e.get('source'), e.get('level'), e.get('text'), e.get('url', '')))
        self.events.append(j)

    def pump(self, seconds):
        end = time.time() + seconds
        self.ws.s.settimeout(0.2)
        try:
            while time.time() < end:
                try:
                    m = self.ws.recv()
                except socket.timeout:
                    continue
                if m:
                    self.on_event(json.loads(m))
        finally:
            self.ws.s.settimeout(None)

    def metrics(self, w, h, dpr):
        self.call('Emulation.setDeviceMetricsOverride', width=w, height=h, deviceScaleFactor=dpr, mobile=False)
        self.call('Emulation.setTouchEmulationEnabled', enabled=True, maxTouchPoints=5)

    def goto(self, url):
        self.call('Page.navigate', url=url)

    def eval(self, js):
        r = self.call('Runtime.evaluate', expression=js, returnByValue=True, awaitPromise=True)
        return r.get('result', {}).get('value')

    def shot(self, path):
        r = self.call('Page.captureScreenshot', format='png')
        open(path, 'wb').write(base64.b64decode(r['data']))

    def tap(self, x, y):
        self.call('Input.dispatchTouchEvent', type='touchStart', touchPoints=[{'x': x, 'y': y}])
        self.call('Input.dispatchTouchEvent', type='touchEnd', touchPoints=[])

    def drag(self, x1, y1, x2, y2, ms, steps=30):
        """Synthetic one-finger drag: touchStart, `steps` touchMoves spread over `ms`, touchEnd."""
        self.call('Input.dispatchTouchEvent', type='touchStart', touchPoints=[{'x': x1, 'y': y1}])
        for i in range(1, steps + 1):
            t = i / steps
            self.call('Input.dispatchTouchEvent', type='touchMove', touchPoints=[{'x': x1 + (x2 - x1) * t, 'y': y1 + (y2 - y1) * t}])
            self.pump(ms / 1000.0 / steps)
        self.call('Input.dispatchTouchEvent', type='touchEnd', touchPoints=[])

    def click(self, x, y):
        self.call('Input.dispatchMouseEvent', type='mouseMoved', x=x, y=y)
        self.call('Input.dispatchMouseEvent', type='mousePressed', x=x, y=y, button='left', clickCount=1)
        self.call('Input.dispatchMouseEvent', type='mouseReleased', x=x, y=y, button='left', clickCount=1)


def main():
    args = sys.argv[1:]
    port = 9333
    if args and args[0] == '--port':
        port = int(args[1]); args = args[2:]
    c = CDP(port)
    i = 0
    while i < len(args):
        a = args[i]
        v = args[i + 1] if i + 1 < len(args) else None
        if a == '--metrics':
            w, h, d = v.split('x'); c.metrics(int(w), int(h), float(d)); i += 2
        elif a == '--goto':
            c.goto(v); i += 2
        elif a == '--reload':
            c.call('Page.reload'); i += 1
        elif a == '--wait':
            c.pump(float(v)); i += 2
        elif a == '--shot':
            c.shot(v); print('shot', v); i += 2
        elif a == '--eval':
            print('eval:', json.dumps(c.eval(v), ensure_ascii=False)); i += 2
        elif a == '--tap':
            x, y = v.split(','); c.tap(float(x), float(y)); i += 2
        elif a == '--click':
            x, y = v.split(','); c.click(float(x), float(y)); i += 2
        elif a == '--drag':
            x1, y1, x2, y2, ms = v.split(','); c.drag(float(x1), float(y1), float(x2), float(y2), float(ms)); i += 2
        elif a == '--cdp':
            # generic command: --cdp Emulation.setCPUThrottlingRate '{"rate": 8}'
            params = json.loads(args[i + 2]) if i + 2 < len(args) else {}
            print('cdp:', v, json.dumps(c.call(v, **params))[:200]); i += 3
        elif a == '--console':
            print('console (%d):' % len(c.console))
            for line in c.console:
                print('  ' + line[:300])
            c.console = []
            i += 1
        else:
            raise SystemExit('unknown step ' + a)
    c.call('Target.closeTarget', targetId=c.target)


if __name__ == '__main__':
    main()
