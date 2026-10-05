"""Эталонные векторы speed ramp → shared/fixtures/time_remap_vectors.json.

Бэк — генератор эталона (CONTRACT §5.1). Фронт и бэк гоняют эти векторы в тестах.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.timeremap import keys_from_json, solve, source_time

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "shared" / "fixtures"
SAMPLES = 21  # τ = 0, D/20, …, D


def _extra_cases() -> list[dict[str, Any]]:
    return [
        {
            "name": "constant-1x-free",
            "remap": {
                "keyframes": [{"u": 0, "speed": 1, "ease": "linear"}, {"u": 1, "speed": 1, "ease": "linear"}],
                "fit": "free",
                "frameBlend": False,
            },
            "D": 2.0,
            "sourceIn": 1.0,
            "sourceOut": 0.0,
            "reverse": False,
        },
        {
            "name": "linear-0.5-to-2-free",
            "remap": {
                "keyframes": [
                    {"u": 0, "speed": 0.5, "ease": "linear"},
                    {"u": 1, "speed": 2, "ease": "linear"},
                ],
                "fit": "free",
                "frameBlend": False,
            },
            "D": 1.0,
            "sourceIn": 0.0,
            "sourceOut": 0.0,
            "reverse": False,
        },
        {
            "name": "custom-bezier-stretch",
            "remap": {
                "keyframes": [
                    {"u": 0, "speed": 2.5, "ease": {"bezier": [0.7, 0, 0.3, 1]}},
                    {"u": 0.5, "speed": 0.3, "ease": {"bezier": [0.2, 0.8, 0.4, 1]}},
                    {"u": 1, "speed": 1.5, "ease": "linear"},
                ],
                "fit": "stretch",
                "frameBlend": True,
            },
            "D": 0.75,
            "sourceIn": 3.2,
            "sourceOut": 4.4,
            "reverse": False,
        },
        {
            "name": "hold-steps-stretch-reverse",
            "remap": {
                "keyframes": [
                    {"u": 0, "speed": 1, "ease": "hold"},
                    {"u": 0.25, "speed": 4, "ease": "hold"},
                    {"u": 0.5, "speed": 0.5, "ease": "hold"},
                    {"u": 1, "speed": 0.5, "ease": "linear"},
                ],
                "fit": "stretch",
                "frameBlend": False,
            },
            "D": 1.6,
            "sourceIn": 10.0,
            "sourceOut": 12.5,
            "reverse": True,
        },
    ]


def build() -> dict[str, Any]:
    presets = json.loads((FIXTURES / "ramp_presets.json").read_text(encoding="utf-8"))["presets"]
    cases: list[dict[str, Any]] = [
        {
            "name": f"preset-{p['id']}",
            "remap": p["timeRemap"],
            "D": 0.9375,  # 2 бита на 128 BPM
            "sourceIn": 5.0,
            "sourceOut": 6.5,
            "reverse": False,
        }
        for p in presets
    ]
    cases += _extra_cases()

    vectors = []
    for c in cases:
        keys = keys_from_json(c["remap"]["keyframes"])
        fit = c["remap"]["fit"]
        d, s_in = c["D"], c["sourceIn"]
        s_out = solve(keys, fit, d, s_in, c["sourceOut"]).source_out
        samples = []
        for i in range(SAMPLES):
            tau = d * i / (SAMPLES - 1)
            src = source_time(keys, fit, d, s_in, c["sourceOut"], tau, c["reverse"])
            samples.append({"tau": round(tau, 9), "src": round(src, 9)})
        vectors.append({**c, "sourceOut": round(s_out, 9), "samples": samples})
    return {"version": 1, "tolerance": 1e-4, "vectors": vectors}


def main() -> None:
    out = FIXTURES / "time_remap_vectors.json"
    out.write_text(json.dumps(build(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"written {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
