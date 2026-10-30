#!/usr/bin/env python3
import subprocess
import sys
import time
import unittest
from pathlib import Path

SUPERVISOR = Path(__file__).with_name('e2e-deadline.py')


class DeadlineTest(unittest.TestCase):
    def test_normal_exit_is_preserved(self):
        result = subprocess.run([sys.executable, str(SUPERVISOR), '3', '1', sys.executable, '-c', 'raise SystemExit(7)'], timeout=6)
        self.assertEqual(result.returncode, 7)

    def test_timeout_kills_term_resistant_descendant_after_parent_exits(self):
        # The child inherits stdout: communicate cannot finish while it survives.
        program = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)']); time.sleep(60)"
        start = time.monotonic()
        result = subprocess.run([sys.executable, str(SUPERVISOR), '1', '1', sys.executable, '-c', program], capture_output=True, timeout=6)
        self.assertEqual(result.returncode, 124)
        self.assertLess(time.monotonic() - start, 5)

    def test_normal_parent_exit_does_not_orphan_term_resistant_child(self):
        program = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)']); time.sleep(.5)"
        result = subprocess.run([sys.executable, str(SUPERVISOR), '3', '1', sys.executable, '-c', program], capture_output=True, timeout=6)
        self.assertEqual(result.returncode, 0)

    def test_external_termination_escalates_resistant_descendant(self):
        child = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(60)"
        program = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]); time.sleep(60)"
        process = subprocess.Popen([sys.executable, str(SUPERVISOR), '30', '1', sys.executable, '-c', program], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            process.terminate()
            process.communicate(timeout=6)
            self.assertEqual(process.returncode, 143)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=3)


if __name__ == '__main__':
    unittest.main()
