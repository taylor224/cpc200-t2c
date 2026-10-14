#!/usr/bin/env python3
"""Static checks for the web UI (run: python3 test/check.py)."""
import json, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WWW = os.path.join(ROOT, 'src', 'www')
fails = 0


def check(cond, msg):
    global fails
    print(('ok   ' if cond else 'FAIL ') + msg)
    if not cond:
        fails += 1


# 1. index.in must not contain '|' (adapter template token character)
src = open(os.path.join(WWW, 'index.in'), encoding='utf-8').read()
check('|' not in src, 'index.in has no "|" characters')

# 2. every id referenced by app.js via $('id') exists in index.in
app = open(os.path.join(WWW, 'js', 'app.js'), encoding='utf-8').read()
ids = set(re.findall(r"\$\('([a-zA-Z0-9_-]+)'\)", app))
dom_ids = set(re.findall(r'id="([^"]+)"', src))
missing = sorted(i for i in ids if i not in dom_ids)
check(not missing, 'all $(id) targets exist in index.in' + ('' if not missing else ': missing ' + ', '.join(missing)))

# 3. every data-i18n key in index.in exists in the English table, and all languages share keys
i18n = open(os.path.join(WWW, 'js', 'i18n.js'), encoding='utf-8').read()
tables = {}
for m in re.finditer(r"T(?:\.(\w+)|\['([\w-]+)'\])\s*=\s*\{(.*?)\n  \};", i18n, re.S):
    name = m.group(1) or m.group(2)
    tables[name] = set(re.findall(r"'([a-z]+\.[a-z0-9_]+)':", m.group(3)))
check(set(tables) == {'en', 'ko', 'ja', 'zh-CN', 'zh-TW'}, 'five language tables present: ' + ', '.join(sorted(tables)))
en = tables.get('en', set())
for name, keys in tables.items():
    diff = sorted(en ^ keys)
    check(not diff, 'keys of %s match en' % name + ('' if not diff else ': ' + ', '.join(diff)))
html_keys = set(re.findall(r'data-i18n="([^"]+)"', src))
missing_keys = sorted(k for k in html_keys if k not in en)
check(not missing_keys, 'all data-i18n keys in index.in exist' + ('' if not missing_keys else ': ' + ', '.join(missing_keys)))
js_keys = set(re.findall(r"t\('([a-z]+\.[a-z0-9_]+)'", app)) | set(re.findall(r"I\.t\('([a-z]+\.[a-z0-9_]+)'", open(os.path.join(WWW, 'js', 'video.js')).read()))
missing_js = sorted(k for k in js_keys if k not in en)
check(not missing_js, 'all t() keys in JS exist' + ('' if not missing_js else ': ' + ', '.join(missing_js)))

# 4. lan files for the adapter's template engine stay within limits
for n in range(3):
    p = os.path.join(WWW, 'lan', '%d.txt' % n)
    lines = open(p, encoding='utf-8').read().split('\n')
    check(len(lines) <= 128, 'lan/%d.txt has %d lines (<= 128)' % (n, len(lines)))

# 5. JS syntax
for f in sorted(os.listdir(os.path.join(WWW, 'js'))):
    if f.endswith('.js'):
        r = subprocess.run(['node', '--check', os.path.join(WWW, 'js', f)], capture_output=True, text=True)
        check(r.returncode == 0, 'node --check js/%s' % f + ('' if r.returncode == 0 else '\n' + r.stderr))

# 6. total size budget (the adapter copies www into RAM at boot)
total = 0
for d, _, fs in os.walk(WWW):
    for f in fs:
        total += os.path.getsize(os.path.join(d, f))
check(total < 2200 * 1024, 'src/www total %d KB < 2200 KB (includes the 1.4 MB H.264 decoder)' % (total // 1024))

print('\n%d failure(s)' % fails)
sys.exit(1 if fails else 0)
