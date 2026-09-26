#!/usr/bin/env python3
"""Double-fork daemon launcher for the Next.js dev server.

The sandbox kills all descendants of the tool shell when a tool call ends.
A double fork detaches the daemon: the intermediate parent exits immediately,
so the grandchild is re-parented to PID 1 (tini) and survives.
"""
import os
import sys

DEVNULL = os.open(os.devnull, os.O_RDWR)


def daemonize() -> None:
    # First fork: parent exits right away so the tool shell has no live child.
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    # Second fork: intermediate exits, grandchild re-parents to PID 1 and
    # can never re-acquire a controlling terminal.
    if os.fork() > 0:
        os._exit(0)
    os.dup2(DEVNULL, 0)
    os.dup2(DEVNULL, 1)
    os.dup2(DEVNULL, 2)


def main() -> None:
    # Kill any previous dev server bound to :3000 so a stale process
    # never keeps serving old code after a restart (ops lesson from
    # Phase 5: `start-dev-daemon` while a server is running is a NO-OP
    # that silently leaves old code live).
    #
    # OPS LESSON (Phase 6): `fuser` is NOT installed in this sandbox —
    # the old `fuser -k 3000/tcp || true` silently no-opped, so a
    # stale server survived every "restart" and kept serving a
    # DELETED database inode after a reset (reads OK, writes fail
    # SQLITE_READONLY). Kill by port via lsof/pkill and WAIT until
    # the port is actually free before binding.
    import socket
    import time

    def port_free(port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex(("127.0.0.1", port)) != 0

    os.system("lsof -ti tcp:3000 2>/dev/null | xargs -r kill -9 2>/dev/null || true")
    os.system("pkill -9 -f 'next dev' 2>/dev/null || true")
    os.system("pkill -9 -f 'next-server' 2>/dev/null || true")
    deadline = time.time() + 15
    while time.time() < deadline and not port_free(3000):
        time.sleep(0.5)
    time.sleep(1.0)
    daemonize()
    os.chdir("/home/z/my-project")
    os.execvp("bun", ["bun", "run", "dev"])


if __name__ == "__main__":
    sys.exit(main())
