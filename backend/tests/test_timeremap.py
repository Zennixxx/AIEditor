from __future__ import annotations

import pytest

from app.timeremap import cubic_bezier, integral, keys_from_json, solve, source_time
from tests.conftest import FIXTURES, load_json

VECTORS = load_json(FIXTURES / "time_remap_vectors.json")


@pytest.mark.parametrize("vec", VECTORS["vectors"], ids=lambda v: v["name"])
def test_reference_vectors(vec: dict) -> None:
    tol = VECTORS["tolerance"]
    keys = keys_from_json(vec["remap"]["keyframes"])
    fit = vec["remap"]["fit"]
    src_out_in = vec["sourceOut"] if fit == "stretch" else 0.0
    res = solve(keys, fit, vec["D"], vec["sourceIn"], src_out_in)
    assert res.source_out == pytest.approx(vec["sourceOut"], abs=tol)
    for s in vec["samples"]:
        got = source_time(keys, fit, vec["D"], vec["sourceIn"], src_out_in, s["tau"], vec["reverse"])
        assert got == pytest.approx(s["src"], abs=tol), f"tau={s['tau']}"


def test_stretch_consumes_exact_source_range() -> None:
    keys = keys_from_json(
        [
            {"u": 0, "speed": 3, "ease": "easeInOut"},
            {"u": 0.5, "speed": 0.2, "ease": "easeInOut"},
            {"u": 1, "speed": 3, "ease": "linear"},
        ]
    )
    assert source_time(keys, "stretch", 1.2, 2.0, 5.0, 0.0) == pytest.approx(2.0)
    assert source_time(keys, "stretch", 1.2, 2.0, 5.0, 1.2) == pytest.approx(5.0)


def test_linear_integral_closed_form() -> None:
    keys = keys_from_json([{"u": 0, "speed": 1, "ease": "linear"}, {"u": 1, "speed": 3, "ease": "linear"}])
    assert integral(keys, 1.0) == pytest.approx(2.0, abs=1e-9)
    assert integral(keys, 0.5) == pytest.approx(0.5 + 0.25, abs=1e-9)


def test_cubic_bezier_endpoints_and_symmetry() -> None:
    assert cubic_bezier(0.42, 0, 0.58, 1, 0) == 0
    assert cubic_bezier(0.42, 0, 0.58, 1, 1) == 1
    assert cubic_bezier(0.42, 0, 0.58, 1, 0.5) == pytest.approx(0.5, abs=1e-6)
