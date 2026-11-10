#!/usr/bin/env python3
"""Archive-derived checks for the proof.

Every check reads the digest-pinned source archive. The only check that reads the
candidate-writable tree is `compare`, and it asks whether that tree still equals the archive.
  list <source.tar>             protected-suite inventory the archive tracks, one path per line
  compare <source.tar> <root>   every regular file the archive tracks is byte-identical under root
  launch <emulator.jar>         emulator launch forms the jar supports, in preference order
"""
import os
import re
import stat
import sys
import tarfile
import zipfile

EXCLUDED_DIRS = {'node_modules', 'build', '.claude', '.git'}
TEST_FILE = re.compile(r'\.(test|spec)\.[cm]?[jt]sx?$')
CLOUD_FIRESTORE = 'com/google/cloud/datastore/emulator/firestore/CloudFirestore.class'


def fail(message):
    raise SystemExit(f'source archive: {message}')


def members(path):
    """Yield (name, member) for regular files; reject every other non-directory member."""
    seen = set()
    with tarfile.open(path, 'r:') as t:
        for m in t:
            name = m.name
            parts = name.split('/')
            if name.startswith('/') or '..' in parts or name in ('', '.'):
                fail(f'unsafe member name {name!r}')
            if m.isdir():
                continue
            if not m.isreg():
                fail(f'non-regular member {name!r}')
            if name in seen:
                fail(f'duplicate member {name!r}')
            seen.add(name)
            yield name, m, t


def list_tests(archive):
    count = 0
    for name, _m, _t in members(archive):
        parts = name.split('/')
        if any(p in EXCLUDED_DIRS for p in parts[:-1]):
            continue
        if TEST_FILE.search(parts[-1]):
            print(name)
            count += 1
    if count == 0:
        fail('no test files in the archive')


def read_tree_file(root, name):
    current = root
    parts = name.split('/')
    for i, part in enumerate(parts):
        current = os.path.join(current, part)
        try:
            st = os.lstat(current)
        except OSError:
            fail(f'missing from tree: {name}')
        if stat.S_ISLNK(st.st_mode):
            fail(f'symlink in tree: {name}')
        if i < len(parts) - 1 and not stat.S_ISDIR(st.st_mode):
            fail(f'parent is not a directory in tree: {name}')
    if not stat.S_ISREG(st.st_mode):
        fail(f'not a regular file in tree: {name}')
    with open(current, 'rb') as f:
        return f.read()


def compare(archive, root):
    count = 0
    for name, m, t in members(archive):
        want = t.extractfile(m).read()
        if read_tree_file(root, name) != want:
            fail(f'tree differs from archive: {name}')
        count += 1
    print(f'compare: {count} archived regular files identical')


def launch(jar):
    with zipfile.ZipFile(jar) as z:
        names = set(z.namelist())
        manifest = ''
        if 'META-INF/MANIFEST.MF' in names:
            manifest = z.read('META-INF/MANIFEST.MF').decode('utf-8', 'replace')
    has_main = any(line.startswith('Main-Class:') for line in manifest.splitlines())
    forms = []
    if has_main:
        forms.append('jar-firebase')
    if CLOUD_FIRESTORE in names:
        forms.append('class')
    if has_main:
        forms.append('jar-start')
    if not forms:
        fail('emulator jar has no supported launch form')
    print('\n'.join(forms))


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['list'] and len(args) == 2:
        list_tests(args[1])
    elif args[:1] == ['compare'] and len(args) == 3:
        compare(args[1], args[2])
    elif args[:1] == ['launch'] and len(args) == 2:
        launch(args[1])
    else:
        fail('usage: check-tree.py list <tar> | compare <tar> <root> | launch <jar>')
