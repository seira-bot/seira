#!/usr/bin/env python3
"""Bundle ES modules into one self-contained HTML page.

Some browsers open a local file without access to its sibling files, so a
page that imports './engine.js' fails. This tool puts every reachable module
into the page as text and loads it through Blob URLs at runtime.

Usage:
  python3 bundle.py ENTRY.js OUT.html [--html SHELL.html] [--title TEXT] [--embed-three]

- ENTRY.js: the start module. It may import 'three' and relative paths.
- 'three' resolves to Three.js r185 on cdn.jsdelivr.net. Some browser panes
  do not open local pages above about 500 KB, so the default keeps Three.js
  out of the page. Add --embed-three to put vendor/three/ into the page for
  offline use (the page is then about 780 KB).
- SHELL.html: optional page body. It must contain the comment <!--BUNDLE-->.
  Without a shell, the page gets a full-window <div id="stage">.
- Only specifiers that start with './' or '../', or that equal 'three',
  are rewritten. Import cycles are not supported.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.path.dirname(HERE)
THREE = os.path.join(LIVE, 'vendor', 'three', 'three.module.min.js')
THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.min.js'
EMBED = {'three': False}
SPEC = re.compile(r"""(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2""")

DEFAULT_SHELL = """<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>html,body{{margin:0;height:100%;background:#F2F4F1}}#stage{{position:fixed;inset:0}}</style>
</head><body><div id="stage"></div>
<!--BUNDLE-->
</body></html>
"""


def resolve(spec, importer):
    if spec == 'three':
        return THREE
    if spec.startswith('./') or spec.startswith('../'):
        return os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    return None


def collect(entry):
    mods, order = {}, []

    def visit(path, stack):
        if path in mods:
            return
        if path in stack:
            raise SystemExit('import cycle: ' + ' -> '.join(stack + [path]))
        if not os.path.isfile(path):
            raise SystemExit('missing module: ' + path)
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        deps = []

        def sub(m):
            # Skip imports quoted in comment lines (// ... or * ...).
            line = src[src.rfind('\n', 0, m.start()) + 1:m.start()].lstrip()
            if line.startswith('//') or line.startswith('*') or line.startswith('/*'):
                return m.group(0)
            if m.group(3) == 'three' and not EMBED['three']:
                return m.group(1) + m.group(2) + THREE_CDN + m.group(2)
            target = resolve(m.group(3), path)
            if target is None:
                return m.group(0)
            deps.append(target)
            return m.group(1) + m.group(2) + '@@mod:' + target + '@@' + m.group(2)

        out = SPEC.sub(sub, src)
        for d in deps:
            visit(d, stack + [path])
        mods[path] = out
        order.append(path)

    visit(os.path.abspath(entry), [])
    return mods, order


def relative_keys(mods, entry):
    """Key each module by its path relative to the common folder of all modules.

    Absolute keys would put the folder names of this machine into the page.
    """
    base = os.path.commonpath(list(mods))
    if base in mods:                      # one module only: base is the file
        base = os.path.dirname(base)

    def key(path):
        return os.path.relpath(path, base).replace(os.sep, '/')

    ref = re.compile(r'@@mod:([^@]+)@@')
    out = {key(p): ref.sub(lambda m: '@@mod:' + key(m.group(1)) + '@@', src)
           for p, src in mods.items()}
    return out, key(entry)


LOADER = """<script>
(function () {
  var mods = JSON.parse(document.getElementById('bundle-mods').textContent);
  var urls = {};
  function url(key) {
    if (urls[key]) return urls[key];
    var src = mods[key].replace(/@@mod:([^@]+)@@/g, function (_, k) { return url(k); });
    urls[key] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return urls[key];
  }
  window.__bundleReady = import(url(%s)).catch(function (e) {
    console.error(e);
    var p = document.createElement('pre');
    p.style.cssText = 'position:fixed;left:8px;bottom:8px;margin:0;color:#B01235;font:12px monospace;white-space:pre-wrap';
    p.textContent = String(e && e.stack || e);
    document.body.appendChild(p);
  });
})();
</script>"""


def main(argv):
    args = [a for a in argv[1:]]
    shell, title = None, 'Seira'
    if '--html' in args:
        i = args.index('--html'); shell = args[i + 1]; del args[i:i + 2]
    if '--embed-three' in args:
        args.remove('--embed-three'); EMBED['three'] = True
    if '--title' in args:
        i = args.index('--title'); title = args[i + 1]; del args[i:i + 2]
    if len(args) != 2:
        raise SystemExit(__doc__)
    entry, out = args
    mods, order = collect(entry)
    mods, entry_key = relative_keys(mods, os.path.abspath(entry))
    payload = json.dumps(mods).replace('</', '<\\/').replace('<!--', '<\\u0021--')
    block = ('<script type="application/json" id="bundle-mods">' + payload + '</script>\n'
             + LOADER % json.dumps(entry_key))
    if shell:
        with open(shell, encoding='utf-8') as fh:
            page = fh.read()
        if '<!--BUNDLE-->' not in page:
            raise SystemExit('shell has no <!--BUNDLE--> marker')
    else:
        page = DEFAULT_SHELL.format(title=title)
    page = page.replace('<!--BUNDLE-->', block)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(page)
    print('bundled %d modules, %d bytes -> %s' % (len(order), len(page), out))


if __name__ == '__main__':
    main(sys.argv)
