#!/usr/bin/env python3
"""Solves an LRCLIB proof-of-work challenge (POST /api/request-challenge).

Matches tranxuanthang/lrcget's challenge_solver.rs: finds a non-negative
integer nonce such that SHA-256(f"{prefix}{nonce}") <= target when compared as
big-endian 32-byte integers. Prints the decimal nonce to stdout.
"""

from __future__ import annotations

import hashlib
import multiprocessing
import os
import sys

# Bounded worker count: keeps memory tiny (~15 MB per worker) while solving
# 24-bit LRCLIB challenges in a few seconds instead of blocking the service.
MAX_WORKERS = 4
CHUNK_SIZE = 50_000


def _solve_range(prefix_bytes: bytes, target: bytes, start: int, count: int) -> int | None:
    sha = hashlib.sha256
    base = sha(prefix_bytes)
    copy = base.copy
    for nonce in range(start, start + count):
        h = copy()
        h.update(f"{nonce}".encode("ascii"))
        if h.digest() <= target:
            return nonce
    return None


def _worker(
    prefix_bytes: bytes,
    target: bytes,
    worker_id: int,
    workers: int,
    stop_event: multiprocessing.Event,
    out_queue: multiprocessing.Queue,
) -> None:
    sha = hashlib.sha256
    base = sha(prefix_bytes)
    copy = base.copy
    batch = worker_id
    while not stop_event.is_set():
        start = batch * CHUNK_SIZE
        end = start + CHUNK_SIZE
        for nonce in range(start, end):
            h = copy()
            h.update(f"{nonce}".encode("ascii"))
            if h.digest() <= target:
                stop_event.set()
                out_queue.put(nonce)
                return
        batch += workers


def solve_challenge(prefix: str, target_hex: str) -> str:
    target = bytes.fromhex(target_hex.strip())
    if len(target) != 32:
        raise ValueError(f"target must be 32 bytes (64 hex chars), got {len(target)}")
    prefix_bytes = prefix.encode("utf-8")

    # Fast single-process path for easy challenges (and unit tests).
    quick = _solve_range(prefix_bytes, target, 0, CHUNK_SIZE)
    if quick is not None:
        return str(quick)

    workers = max(1, min(MAX_WORKERS, os.cpu_count() or 1))
    if workers == 1:
        start = CHUNK_SIZE
        while True:
            found = _solve_range(prefix_bytes, target, start, CHUNK_SIZE)
            if found is not None:
                return str(found)
            start += CHUNK_SIZE

    ctx = multiprocessing.get_context("fork" if hasattr(os, "fork") else "spawn")
    stop_event = ctx.Event()
    out_queue = ctx.Queue()
    procs = [
        ctx.Process(
            target=_worker,
            args=(prefix_bytes, target, i, workers, stop_event, out_queue),
            daemon=True,
        )
        for i in range(workers)
    ]
    for p in procs:
        p.start()
    try:
        nonce = out_queue.get()
        stop_event.set()
        return str(nonce)
    finally:
        for p in procs:
            if p.is_alive():
                p.terminate()
        for p in procs:
            p.join(timeout=1)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print("usage: lrclib-pow.py <prefix> <target-hex>", file=sys.stderr)
        return 2
    print(solve_challenge(args[0], args[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
