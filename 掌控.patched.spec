# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = [("zhangkong/web", "zhangkong/web")]
binaries = []
hiddenimports = []
for package in ("aiohttp", "qrcode", "PIL"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

a = Analysis(
    ["zhangkong_app.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    noarchive=False,
)

# Pyarmor patch start:

def apply_pyarmor_patch():

    srcpath = ['D:\\xuexi\\project\\远程桌面']
    obfpath = 'D:\\xuexi\\project\\远程桌面\\.pyarmor\\pack\\dist'
    pkgname = 'pyarmor_runtime_000000'
    pkgpath = os.path.join(obfpath, pkgname)
    extpath = os.path.join(pkgname, 'pyarmor_runtime.pyd')

    if hasattr(a.pure, '_code_cache'):
        code_cache = a.pure._code_cache
    else:
        from PyInstaller.config import CONF
        code_cache = CONF['code_cache'].get(id(a.pure))

    srclist = [os.path.normcase(x) for x in srcpath]
    def match_obfuscated_script(orgpath):
        for x in srclist:
            if os.path.normcase(orgpath).startswith(x):
                return os.path.join(obfpath, orgpath[len(x)+1:])

    count = 0
    for i in range(len(a.scripts)):
        x = match_obfuscated_script(a.scripts[i][1])
        if x and os.path.exists(x):
            a.scripts[i] = a.scripts[i][0], x, a.scripts[i][2]
            count += 1
    if count == 0:
        raise RuntimeError('No obfuscated script found')

    for i in range(len(a.pure)):
        x = match_obfuscated_script(a.pure[i][1])
        if x and os.path.exists(x):
            if code_cache is not None:
                code_cache.pop(a.pure[i][0], None)
            a.pure[i] = a.pure[i][0], x, a.pure[i][2]

    a.pure.append((pkgname, os.path.join(pkgpath, '__init__.py'), 'PYMODULE'))
    a.binaries.append((extpath, os.path.join(obfpath, extpath), 'EXTENSION'))

apply_pyarmor_patch()

# Pyarmor patch end.
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="掌控",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    icon="zhangkong.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="掌控",
)
