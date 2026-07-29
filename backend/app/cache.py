"""Disk cache. Every area gets a directory keyed by a hash of its request
parameters; DEMs, fetched textures, and uploaded custom layers live there so
repeat loads are instant and the backend stays stateless across restarts."""

from pathlib import Path

CACHE_ROOT = Path(__file__).resolve().parent.parent / "cache"


def area_dir(area_id: str) -> Path:
    p = CACHE_ROOT / area_id
    p.mkdir(parents=True, exist_ok=True)
    return p
