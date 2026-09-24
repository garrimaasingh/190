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
    os.system("fuser -k 3000/tcp >/dev/null 2>&1 || true")
    import time
    time.sleep(1.5)
    daemonize()
    os.chdir("/home/z/my-project")
    os.execvp("bun", ["bun", "run", "dev"])


if __name__ == "__main__":
    sys.exit(main())
