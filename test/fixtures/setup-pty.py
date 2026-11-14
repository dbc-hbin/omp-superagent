"""Real controlling-terminal relay. JSON stdin is private; only PTY output is rendered."""
import base64
import errno
import fcntl
import json
import os
import select
import signal
import subprocess
import sys
import termios
import time

options = json.loads(sys.argv[1])
terminal = options.get("tty", True)
if terminal:
    master, slave = os.openpty()
else:
    master, slave = os.pipe()
notify_read, notify_write = os.pipe()
os.set_blocking(notify_write, False)
signal.signal(signal.SIGCHLD, lambda *_: None)
signal.set_wakeup_fd(notify_write)
pid = os.fork()
if pid == 0:
    signal.set_wakeup_fd(-1)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    os.close(master)
    os.close(notify_read)
    os.close(notify_write)
    os.setsid()
    if terminal:
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        os.tcsetpgrp(slave, os.getpgrp())
        os.dup2(slave, 0)
    else:
        null = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null, 0)
        os.close(null)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    os.execvpe(options["command"][0], options["command"], os.environ)

if not terminal:
    os.close(slave)
os.set_blocking(master, False)
os.set_blocking(0, False)
pending = b""
masked = None
readers = set()


def emit(event):
    print(json.dumps(event), flush=True)


def echo():
    # The master stays open across controlling-session exit; inspect that endpoint.
    return bool(termios.tcgetattr(master)[3] & termios.ECHO) if terminal else None


def processes():
    rows = []
    result = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True, check=True)
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows.append((int(parts[0]), int(parts[1]), parts[2]))
    descendants = {pid}
    while True:
        expanded = descendants | {child for child, parent, _ in rows if parent in descendants}
        if expanded == descendants:
            break
        descendants = expanded
    readers.update(descendants - {pid})
    return [argv for child, _, argv in rows if child in descendants]


def alive(child):
    try:
        os.kill(child, 0)
        return True
    except ProcessLookupError:
        return False


def output():
    while True:
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            return
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        if not data:
            return
        emit({"type": "output", "data": base64.b64encode(data).decode("ascii")})


def stop(*_):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, stop)
try:
    while True:
        exited, status = os.waitpid(pid, os.WNOHANG)
        if exited:
            output()
            code = os.waitstatus_to_exitcode(status)
            # Measure restoration/reaping before the relay's defensive cleanup.
            emit({"type": "exit", "code": code if code >= 0 else 128 - code,
                  "echo": echo(), "remaining": sorted(child for child in readers if alive(child))})
            break
        if masked:
            # Readiness is a kernel ECHO assertion, never an assumed settling delay.
            if not echo():
                request = masked
                masked = None
                os.write(master, base64.b64decode(request["data"]))
                argv = processes()
                emit({"type": "reply", "id": request["id"], "echo": False, "argv": argv,
                      "pid": pid, "readerPids": sorted(readers)})
            elif time.monotonic() >= masked["deadline"]:
                emit({"type": "error", "id": masked["id"], "message": "Secret prompt did not disable terminal ECHO"})
                masked = None
        ready, _, _ = select.select([master, 0, notify_read], [], [], 0.01 if masked else None)
        if master in ready:
            output()
        if notify_read in ready:
            os.read(notify_read, 4096)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                stop()
                continue
            pending += data
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                request = json.loads(line)
                if request["type"] == "write":
                    if request.get("secret"):
                        if masked:
                            raise RuntimeError("Only one masked write may be pending")
                        masked = dict(request, deadline=time.monotonic() + 5)
                    else:
                        os.write(master, base64.b64decode(request["data"]))
                        emit({"type": "reply", "id": request["id"], "echo": echo()})
                else:
                    raise RuntimeError("Unknown relay request")
finally:
    stop()
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    for fd in [master, notify_read, notify_write] + ([slave] if terminal else []):
        os.close(fd)
