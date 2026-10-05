"""Математика speed ramp — docs/CONTRACT.md §5.1.

Фронт реализует то же самое в `frontend/src/model/timeRemap.ts`; совпадение
проверяется векторами из shared/fixtures/time_remap_vectors.json.
"""

from __future__ import annotations

import itertools
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

SIMPSON_STEPS = 256  # отрезков на интервал между ключами (чётное)

NAMED_BEZIER: dict[str, tuple[float, float, float, float]] = {
    "easeIn": (0.42, 0.0, 1.0, 1.0),
    "easeOut": (0.0, 0.0, 0.58, 1.0),
    "easeInOut": (0.42, 0.0, 0.58, 1.0),
}

type EaseSpec = str | tuple[float, float, float, float]


@dataclass(frozen=True, slots=True)
class RampKey:
    u: float
    speed: float
    ease: EaseSpec


def cubic_bezier(x1: float, y1: float, x2: float, y2: float, x: float) -> float:
    """y по x для кривой CSS cubic-bezier (P0=(0,0), P3=(1,1))."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0

    def bx(t: float) -> float:
        return ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t

    def by(t: float) -> float:
        return ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t

    def dbx(t: float) -> float:
        return 3 * (1 - 3 * x2 + 3 * x1) * t * t + 2 * (3 * x2 - 6 * x1) * t + 3 * x1

    # Ньютон, затем бисекция как страховка — те же шаги на фронте.
    t = x
    for _ in range(8):
        err = bx(t) - x
        if abs(err) < 1e-7:
            return by(t)
        d = dbx(t)
        if abs(d) < 1e-6:
            break
        t -= err / d
    lo, hi = 0.0, 1.0
    t = x
    for _ in range(60):
        v = bx(t)
        if abs(v - x) < 1e-7:
            break
        if v < x:
            lo = t
        else:
            hi = t
        t = (lo + hi) / 2
    return by(t)


def ease_value(ease: EaseSpec, p: float) -> float:
    """Доля перехода к следующему ключу при параметре p ∈ [0, 1]."""
    if isinstance(ease, tuple):
        return cubic_bezier(*ease, p)
    if ease == "linear":
        return p
    if ease == "hold":
        return 1.0 if p >= 1.0 else 0.0
    if ease in NAMED_BEZIER:
        return cubic_bezier(*NAMED_BEZIER[ease], p)
    raise ValueError(f"unknown ease {ease!r}")


def speed_at(keys: Sequence[RampKey], u: float) -> float:
    """Профиль скорости s(u)."""
    if u <= keys[0].u:
        return keys[0].speed
    if u >= keys[-1].u:
        return keys[-1].speed
    for a, b in itertools.pairwise(keys):
        if a.u <= u <= b.u:
            span = b.u - a.u
            if span <= 0:
                return b.speed
            p = (u - a.u) / span
            return a.speed + (b.speed - a.speed) * ease_value(a.ease, p)
    return keys[-1].speed


def _simpson(keys: Sequence[RampKey], a: float, b: float) -> float:
    if b <= a:
        return 0.0
    n = SIMPSON_STEPS
    h = (b - a) / n
    # Значение в правой границе интервала берём как предел слева, чтобы "hold"
    # не схлопывал последний отрезок в скорость следующего ключа.
    total = speed_at(keys, a) + _left_limit(keys, b)
    for i in range(1, n):
        total += (4 if i % 2 else 2) * speed_at(keys, a + i * h)
    return total * h / 3


def _left_limit(keys: Sequence[RampKey], u: float) -> float:
    for a, b in itertools.pairwise(keys):
        if a.u < u <= b.u:
            span = b.u - a.u
            p = (u - a.u) / span
            e = ease_value(a.ease, p) if not (a.ease == "hold" and p >= 1.0) else 0.0
            return a.speed + (b.speed - a.speed) * e
    return speed_at(keys, u)


def integral(keys: Sequence[RampKey], u: float) -> float:
    """S(u) = ∫₀ᵘ s(x) dx — Симпсон по каждому интервалу между ключами."""
    u = min(max(u, 0.0), 1.0)
    total = 0.0
    for a, b in itertools.pairwise(keys):
        if u <= a.u:
            break
        total += _simpson(keys, a.u, min(u, b.u))
    return total


@dataclass(frozen=True, slots=True)
class RemapResult:
    k: float
    source_out: float


def solve(
    keys: Sequence[RampKey],
    fit: Literal["stretch", "free"],
    duration: float,
    source_in: float,
    source_out: float,
) -> RemapResult:
    total = integral(keys, 1.0)
    if fit == "stretch":
        return RemapResult(k=(source_out - source_in) / (duration * total), source_out=source_out)
    return RemapResult(k=1.0, source_out=source_in + duration * total)


def source_time(
    keys: Sequence[RampKey],
    fit: Literal["stretch", "free"],
    duration: float,
    source_in: float,
    source_out: float,
    tau: float,
    reverse: bool = False,
) -> float:
    """src(τ) для τ ∈ [0, D] от начала клипа."""
    res = solve(keys, fit, duration, source_in, source_out)
    tau = min(max(tau, 0.0), duration)
    src = source_in + duration * res.k * integral(keys, tau / duration)
    if reverse:
        src = res.source_out - (src - source_in)
    return src


def keys_from_json(raw: Sequence[dict]) -> list[RampKey]:
    out: list[RampKey] = []
    for k in raw:
        ease = k["ease"]
        if isinstance(ease, dict):
            x1, y1, x2, y2 = ease["bezier"]
            ease = (float(x1), float(y1), float(x2), float(y2))
        out.append(RampKey(u=float(k["u"]), speed=float(k["speed"]), ease=ease))
    return out
