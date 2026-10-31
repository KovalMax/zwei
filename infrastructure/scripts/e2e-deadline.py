#!/usr/bin/env python3
"""Bound a disposable E2E subprocess and its process group, including children."""
import os
import signal
import subprocess
import sys
import time


def main() -> int:
    if len(sys.argv) < 4:
        return 2
    timeout, grace = float(sys.argv[1]), float(sys.argv[2])
    if timeout <= 0 or grace <= 0:
        return 2
    interrupted = 0

    def interrupt(signum, _frame):
        nonlocal interrupted
        interrupted = signum

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    child = subprocess.Popen(sys.argv[3:], start_new_session=True)

    deadline = time.monotonic() + timeout
    while child.poll() is None and not interrupted and time.monotonic() < deadline:
        time.sleep(0.1)
    completed = child.poll() is not None and not interrupted

    def signal_group(signum):
        try:
            os.killpg(child.pid, signum)
            return True
        except ProcessLookupError:
            return False

    signal_group(signal.SIGTERM)
    until = time.monotonic() + grace
    while time.monotonic() < until:
        child.poll()  # Reap the group leader even if descendants ignore TERM.
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    signal_group(signal.SIGKILL)
    child.wait()
    if interrupted:
        return 128 + interrupted
    if completed:
        return child.returncode if child.returncode >= 0 else 128 - child.returncode
    print('Isolated E2E subprocess exceeded its deadline', file=sys.stderr)
    return 124


if __name__ == '__main__':
    sys.exit(main())
