#!/usr/bin/env python3
"""Filesystem, descriptor, mount and write boundary for the isolated proof container.

Usage: check-filesystem.py [all|devices|mounts|writes] [writable-dir ...]
  devices  stdout/stderr are write-only pipes or files; no visible socket;
           no usable device outside the allowlist
  mounts   only the mount points the proof expects; root and /stage read-only; the
           bind mounts the proof itself adds must be read-only
  writes   root, /stage and /proc/sys are not writable; any extra directory
           given on the command line must also refuse a probe file
The proof runs `all`. Controls run single modes so each negative fails for its own reason.
Failures print one message beginning "filesystem boundary:" and exit non-zero.
Unreadable directories are counted and listed, never treated as clean.

Known blind spots, stated rather than hidden: /proc, /sys and /dev are not walked for mounts;
Docker's own /etc/hosts, /etc/resolv.conf and /etc/hostname are accepted without an ro requirement.
"""
import errno
import fcntl
import os
import stat
import sys

SAFE_DEVICES = {
    '/dev/null': (1, 3),
    '/dev/zero': (1, 5),
    '/dev/random': (1, 8),
    '/dev/urandom': (1, 9),
    '/dev/full': (1, 7),
    '/dev/tty': (5, 0),
    '/dev/console': (5, 1),
    '/dev/ptmx': (5, 2),
}
# /proc is a private view; /dev/pts is a devpts mount with its own namespace rules.
SKIP_DESCEND = {'/proc', '/dev/pts'}
# Docker's --init binary is bind-mounted read-only at one of these paths, depending on the runner image
# (observed: /usr/sbin on ubuntu-24.04 hosted runners). Either is accepted, and only when it is read-only.
DOCKER_INIT_PATHS = frozenset({'/sbin/docker-init', '/usr/sbin/docker-init'})
REQUIRED_MOUNTS = {
    '/': None,
    '/stage': None,
    '/tmp': 'tmpfs',
    '/opt': 'tmpfs',
    '/run': 'tmpfs',
    '/work': 'tmpfs',
}
OPTIONAL_MOUNTS = {'/etc/hosts', '/etc/resolv.conf', '/etc/hostname'}
# Bind mounts the proof itself adds, or that Docker adds for --init; each must be read-only.
RO_BINDS = frozenset({'/etc/passwd', '/etc/group'}) | DOCKER_INIT_PATHS
ALLOWED_BINDS = OPTIONAL_MOUNTS | RO_BINDS
RO_REQUIRED = ('/', '/stage')
PREFIX_MOUNTS = ('/proc', '/sys', '/dev')
WRITE_PROBES = (
    ('/nsmcp-write-probe', os.O_WRONLY | os.O_CREAT | os.O_EXCL),
    ('/stage/nsmcp-write-probe', os.O_WRONLY | os.O_CREAT | os.O_EXCL),
    ('/proc/sys/kernel/hostname', os.O_WRONLY),
)
unreadable = []


def fail(message):
    raise SystemExit(f'filesystem boundary: {message}')


def check_logging_fds():
    for fd in (1, 2):
        mode = os.fstat(fd).st_mode
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        if not (stat.S_ISFIFO(mode) or stat.S_ISREG(mode)) or (flags & os.O_ACCMODE) != os.O_WRONLY:
            fail(f'fd {fd} is not a write-only pipe or file')


def check_unix_sockets():
    with open('/proc/net/unix', encoding='ascii') as f:
        lines = f.read().splitlines()
    if not lines or not lines[0].lstrip().startswith('Num'):
        fail('unrecognized /proc/net/unix')
    if any(line.strip() for line in lines[1:]):
        fail('UNIX socket present in the private network namespace')


def check_process_sockets():
    for pid in os.listdir('/proc'):
        if not pid.isdecimal():
            continue
        directory = f'/proc/{pid}/fd'
        try:
            descriptors = os.listdir(directory)
        except FileNotFoundError:
            continue  # exited between listing and open
        for fd in descriptors:
            try:
                target = os.readlink(f'{directory}/{fd}')
            except FileNotFoundError:
                continue
            if target.startswith('socket:['):
                fail(f'visible process socket: pid={pid} fd={fd}')


def check_vsock():
    try:
        fd = os.open('/dev/vsock', os.O_RDWR | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as e:
        if e.errno not in (errno.ENOENT, errno.EACCES, errno.EPERM, errno.ENXIO, errno.ENODEV):
            raise
        return
    os.close(fd)
    fail('/dev/vsock is openable')


def walk(path):
    try:
        with os.scandir(path) as it:
            entries = list(it)
    except PermissionError:
        unreadable.append(path)
        return
    for entry in entries:
        p = os.path.join(path, entry.name)
        if p in SKIP_DESCEND:
            continue
        s = entry.stat(follow_symlinks=False)
        if stat.S_ISLNK(s.st_mode):
            continue
        if stat.S_ISSOCK(s.st_mode):
            fail(f'filesystem socket exposed: {p}')
        if stat.S_ISCHR(s.st_mode) or stat.S_ISBLK(s.st_mode):
            safe = (
                p in SAFE_DEVICES
                and stat.S_ISCHR(s.st_mode)
                and (os.major(s.st_rdev), os.minor(s.st_rdev)) == SAFE_DEVICES[p]
            )
            if not safe and (os.access(p, os.R_OK) or os.access(p, os.W_OK)):
                fail(f'usable non-allowlisted device: {p}')
        elif stat.S_ISDIR(s.st_mode):
            walk(p)


def check_devices():
    check_logging_fds()
    check_unix_sockets()
    check_process_sockets()
    check_vsock()
    walk('/')


def check_mounts():
    with open('/proc/self/mountinfo', encoding='utf-8') as f:
        rows = [line.split(' ') for line in f.read().splitlines()]
    seen = {}
    for fields in rows:
        sep = fields.index('-')
        mountpoint = fields[4]
        options = fields[5].split(',')
        fstype = fields[sep + 1]
        if any(mountpoint == p or mountpoint.startswith(p + '/') for p in PREFIX_MOUNTS):
            continue
        if mountpoint in REQUIRED_MOUNTS:
            expected = REQUIRED_MOUNTS[mountpoint]
            if expected is not None and fstype != expected:
                fail(f'{mountpoint} is {fstype}, expected {expected}')
        elif mountpoint not in ALLOWED_BINDS:
            fail(f'unexpected mount: {mountpoint}')
        if mountpoint in RO_BINDS and 'ro' not in options:
            fail(f'{mountpoint} is writable')
        seen[mountpoint] = options
    for mountpoint in REQUIRED_MOUNTS:
        if mountpoint not in seen:
            fail(f'required mount missing: {mountpoint}')
    for mountpoint in RO_REQUIRED:
        if 'ro' not in seen[mountpoint]:
            fail(f'{mountpoint} is writable')


def check_writes(extra_dirs):
    probes = list(WRITE_PROBES)
    for d in extra_dirs:
        probes.append((os.path.join(d, 'nsmcp-write-probe'), os.O_WRONLY | os.O_CREAT | os.O_EXCL))
    for path, flags in probes:
        try:
            fd = os.open(path, flags, 0o600)
        except OSError as e:
            if e.errno in (errno.EROFS, errno.EACCES, errno.EPERM):
                continue
            fail(f'unexpected errno {e.errno} probing {path}')
        os.close(fd)
        if flags & os.O_CREAT:
            os.unlink(path)
        fail(f'writable: {path}')


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if mode not in ('all', 'devices', 'mounts', 'writes'):
        fail(f'unknown mode: {mode}')
    if mode in ('all', 'devices'):
        check_devices()
    if mode in ('all', 'mounts'):
        check_mounts()
    if mode in ('all', 'writes'):
        check_writes(sys.argv[2:] if mode == 'writes' else [])
    print(f'filesystem boundary {mode}: passed; unreadable directories skipped: {len(unreadable)}')
    for p in unreadable[:5]:
        print(f'  unreadable: {p}')
