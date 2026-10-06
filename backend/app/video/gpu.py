"""Vulkan-устройства, которые видит rife-ncnn-vulkan: пробный прогон на двух крошечных кадрах."""

from __future__ import annotations

import logging
import re
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path

from app.media.ffmpeg import CREATE_NO_WINDOW

log = logging.getLogger(__name__)

PROBE_TIMEOUT = 60.0
DEVICE_RE = re.compile(r"^\[(\d+) (.+?)\]\s", re.MULTILINE)


def tiny_png(size: int = 16) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    rows = b"".join(b"\x00" + b"\x80\x80\x80" * size for _ in range(size))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def parse_devices(stderr: str) -> list[str]:
    names: dict[int, str] = {}
    for m in DEVICE_RE.finditer(stderr):
        names.setdefault(int(m.group(1)), m.group(2).strip())
    return [names[i] for i in sorted(names)]


def probe_rife_gpus(rife: Path) -> list[str] | None:
    with tempfile.TemporaryDirectory(prefix="aieditor-gpu-") as tmp:
        folder = Path(tmp)
        a, b, out = folder / "0.png", folder / "1.png", folder / "out.png"
        a.write_bytes(tiny_png())
        b.write_bytes(tiny_png())
        try:
            proc = subprocess.run(
                [str(rife), "-0", str(a), "-1", str(b), "-o", str(out)],
                cwd=rife.parent,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=PROBE_TIMEOUT,
                creationflags=CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired):
            log.exception("rife gpu probe failed")
            return None
    stderr = proc.stderr.decode("utf-8", "replace")
    devices = parse_devices(stderr)
    if not devices:
        log.warning("rife sees no Vulkan GPU (code %s): %s", proc.returncode, stderr[-500:])
    return devices
