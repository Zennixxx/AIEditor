"""Генерация синтетических фикстур в shared/fixtures (детерминированно).

Запуск: `uv --directory backend run python ../tools/gen_fixtures.py`
Владелец shared/ — оркестратор; агенты фикстуры не правят, а предлагают изменения.
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "shared" / "fixtures"
SEED = 1337

BPM = 128.0
BEAT = 60.0 / BPM  # 0.46875
BAR = BEAT * 4  # 1.875
MUSIC_DURATION = 96.0
SECTIONS = [
    (0.0, 15.0, "intro", 0.35),
    (15.0, 30.0, "build", 0.6),
    (30.0, 60.0, "drop", 0.95),
    (60.0, 75.0, "break", 0.3),
    (75.0, 90.0, "drop", 1.0),
    (90.0, 96.0, "outro", 0.25),
]

VIDEO_A = "ast_3f1c9a0b7d2e4c61"
VIDEO_B = "ast_8a7e5d4c3b2a1908"
MUSIC = "ast_c0ffee1234abcd56"
TS = "2026-10-05T12:00:00Z"


def r(x: float, n: int = 6) -> float:
    return round(x, n)


def section_at(t: float) -> tuple[float, float, str, float]:
    for s in SECTIONS:
        if s[0] <= t < s[1]:
            return s
    return SECTIONS[-1]


def write(name: str, data: Any) -> None:
    (FIX / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print("written", f"shared/fixtures/{name}")


def derived(asset_id: str, *, proxy: bool, audio: bool, mezz: bool = False) -> dict[str, str]:
    base = f"/api/assets/{asset_id}"
    d: dict[str, str] = {}
    if proxy:
        d["proxy"] = f"{base}/proxy.mp4"
        d["thumbs"] = f"{base}/thumbs.json"
    if mezz:
        d["mezzanine"] = f"{base}/mezzanine.mp4"
    if audio:
        d["audio"] = f"{base}/audio.m4a"
        d["waveform"] = f"{base}/waveform.json"
    return d


def assets() -> list[dict[str, Any]]:
    return [
        {
            "id": VIDEO_A, "kind": "video", "name": "street_run.mp4",
            "path": "D:\\Footage\\street_run.mp4", "duration": 12.0, "width": 1920, "height": 1080,
            "fps": 30.0, "hasAudio": True, "codec": "h264", "browserDecodable": True, "status": "ready",
            "derived": derived(VIDEO_A, proxy=True, audio=True),
        },
        {
            "id": VIDEO_B, "kind": "video", "name": "drift_closeup.mov",
            "path": "D:\\Footage\\drift_closeup.mov", "duration": 8.0, "width": 3840, "height": 2160,
            "fps": 59.94, "hasAudio": False, "codec": "prores", "browserDecodable": False, "status": "ready",
            "derived": derived(VIDEO_B, proxy=True, audio=False, mezz=True),
        },
        {
            "id": MUSIC, "kind": "audio", "name": "phonk_track.mp3",
            "path": "D:\\Music\\phonk_track.mp3", "duration": MUSIC_DURATION,
            "hasAudio": True, "codec": "mp3", "browserDecodable": True, "status": "ready",
            "derived": derived(MUSIC, proxy=False, audio=True),
        },
    ]


def music_analysis(rng: random.Random) -> dict[str, Any]:
    n_beats = int(MUSIC_DURATION / BEAT)
    beats = [r(i * BEAT) for i in range(n_beats)]
    downbeats = [b for i, b in enumerate(beats) if i % 4 == 0]
    bass, onsets = [], []
    for i, t in enumerate(beats):
        _, _, label, energy = section_at(t)
        on_beat = label == "drop" or (label == "build" and i % 2 == 0) or (i % 4 == 0)
        if on_beat:
            base = 0.95 if i % 4 == 0 else 0.6
            bass.append({"t": r(t + rng.uniform(-0.004, 0.004)), "strength": r(min(1.0, base * energy + rng.uniform(0, 0.1)), 3)})
        if label in ("drop", "build"):
            off = t + BEAT / 2
            onsets.append({"t": r(off), "strength": r(rng.uniform(0.2, 0.5), 3)})
        onsets.append({"t": r(t), "strength": r(rng.uniform(0.4, 0.9) * energy, 3)})
    interval = 0.1
    values = []
    for i in range(int(MUSIC_DURATION / interval)):
        t = i * interval
        _, _, _, e = section_at(t)
        pulse = 0.15 * math.exp(-((t % BEAT) / 0.08))
        values.append(r(min(1.0, e * 0.85 + pulse), 3))
    return {
        "assetId": MUSIC,
        "params": {"bassCutoffHz": 150, "sensitivity": 0.5, "minGapSec": 0.12, "useStems": False},
        "bpm": BPM,
        "beats": beats,
        "downbeats": downbeats,
        "bass": bass,
        "onsets": sorted(onsets, key=lambda o: o["t"]),
        "sections": [{"start": s, "end": e, "label": lbl, "energy": en} for s, e, lbl, en in SECTIONS],
        "energy": {"interval": interval, "values": values},
    }


def waveform(rng: random.Random) -> dict[str, Any]:
    sr, spp = 22050, 256
    n = int(MUSIC_DURATION * sr / spp)
    peaks: list[int] = []
    for i in range(n):
        t = i * spp / sr
        _, _, _, e = section_at(t)
        kick = math.exp(-((t % BEAT) / 0.06))
        amp = min(127, int(127 * (0.25 * e + 0.6 * e * kick + rng.uniform(0, 0.12))))
        peaks += [-amp, amp]
    return {"sampleRate": sr, "samplesPerPeak": spp, "channels": 1, "peaks": peaks}


def thumbs(asset_id: str, duration: float) -> dict[str, Any]:
    count = int(duration)
    return {
        "interval": 1.0, "tileWidth": 160, "tileHeight": 90, "columns": 10, "count": count,
        "sprites": [f"/api/assets/{asset_id}/thumbs/{i}.jpg" for i in range(math.ceil(count / 100))],
    }


def clip_analysis() -> dict[str, Any]:
    motion = [r(0.2 + 0.6 * abs(math.sin(i / 7.0)) * (1.2 if 40 < i < 70 else 0.8), 3) for i in range(120)]
    return {
        "assetId": VIDEO_A,
        "model": "gemini-pro-latest",
        "summary": "Ночная улица, человек бежит к камере, неон, капли дождя на объективе.",
        "moments": [
            {"start": 1.2, "end": 2.6, "score": 0.62, "tags": ["establishing", "neon"], "description": "Общий план улицы с неоном."},
            {"start": 4.0, "end": 5.1, "score": 0.91, "tags": ["action", "run", "closeup"], "description": "Рывок к камере, лицо крупно."},
            {"start": 6.8, "end": 7.6, "score": 0.84, "tags": ["action", "jump"], "description": "Прыжок через лужу, брызги."},
            {"start": 9.5, "end": 11.4, "score": 0.55, "tags": ["slow", "emotion"], "description": "Остановка, тяжёлое дыхание, свет фар."},
        ],
        "shots": [
            {"start": 0.0, "end": 3.0, "type": "wide"},
            {"start": 3.0, "end": 6.0, "type": "closeup"},
            {"start": 6.0, "end": 9.0, "type": "medium"},
            {"start": 9.0, "end": 12.0, "type": "closeup"},
        ],
        "motion": {"interval": 0.1, "values": motion},
    }


def nearest(values: list[float], t: float) -> float:
    return min(values, key=lambda v: abs(v - t))


def project(ma: dict[str, Any], asset_list: list[dict[str, Any]]) -> dict[str, Any]:
    music_markers = []
    for i, b in enumerate(ma["bass"]):
        music_markers.append({"id": f"mrk_bass{i:05d}", "t": b["t"], "kind": "bass", "strength": b["strength"]})
    for i, t in enumerate(ma["downbeats"]):
        music_markers.append({"id": f"mrk_down{i:05d}", "t": t, "kind": "downbeat", "strength": 1.0})
    music_markers.sort(key=lambda m: m["t"])

    identity = {"x": 0, "y": 0, "scale": 1, "rotation": 0, "anchorX": 0, "anchorY": 0}
    drop = 30.0

    def clip(cid: str, asset: str, start: float, dur: float, s_in: float, s_out: float, **extra: Any) -> dict[str, Any]:
        c = {
            "id": cid, "type": "clip", "assetId": asset, "start": r(start), "duration": r(dur),
            "sourceIn": r(s_in), "sourceOut": r(s_out), "speed": 1, "reverse": False,
            "transform": dict(identity), "opacity": 1, "blendMode": "normal", "effects": [], "markers": [],
        }
        c.update(extra)
        return c

    zoom = {
        "id": "fx_zoom000001", "type": "effect", "effect": "zoomPunch", "start": 0, "duration": 0.3,
        "params": {"strength": 1, "amount": 1.15, "centerX": 0, "centerY": 0, "motionBlur": True},
        "envelope": {"attack": 0.02, "hold": 0, "decay": 0.28, "curve": "easeOut"}, "enabled": True,
    }
    fsf = {
        "keyframes": [
            {"u": 0, "speed": 3, "ease": "easeInOut"},
            {"u": 0.35, "speed": 0.25, "ease": "hold"},
            {"u": 0.65, "speed": 0.25, "ease": "easeInOut"},
            {"u": 1, "speed": 3, "ease": "linear"},
        ],
        "fit": "stretch",
        "frameBlend": True,
    }
    video_items = [
        clip("clp_intro00001", VIDEO_A, 0.0, 15.0, 0.0, 7.5, speed=0.5, label="intro slow"),
        clip("clp_build00001", VIDEO_A, 15.0, 15.0, 0.0, 12.0, speed=0.8),
        clip("clp_drop000001", VIDEO_A, drop, BAR, 4.0, 4.0 + BAR, effects=[zoom]),
        clip("clp_drop000002", VIDEO_A, drop + BAR, BAR / 2, 6.6, 7.8, timeRemap=fsf),
        clip("clp_drop000003", VIDEO_B, drop + BAR * 1.5, BAR / 2, 2.0, 2.0 + BAR / 2,
             transform={**identity, "scale": [
                 {"t": 0, "v": 1.0, "ease": "easeOut"},
                 {"t": r(BAR / 2), "v": 1.2, "ease": "linear"},
             ]}),
    ]
    # speed: duration = (sourceOut - sourceIn) / speed
    video_items[0]["duration"] = r((7.5 - 0.0) / 0.5)
    video_items[1]["duration"] = r((12.0 - 0.0) / 0.8)

    anchor_marker = next(m for m in music_markers if m["kind"] == "bass" and abs(m["t"] - (drop + BAR)) < 0.01)
    shake = {
        "id": "fx_shake00001", "type": "effect", "effect": "shake", "start": anchor_marker["t"], "duration": 0.35,
        "params": {"strength": 1, "amount": 40, "frequency": 12, "rotation": 3, "motionBlur": True, "samples": 8},
        "envelope": {"attack": 0, "hold": 0.05, "decay": 0.3, "curve": "exp"},
        "anchor": {"markerId": anchor_marker["id"], "clipId": "clp_music00001", "offset": 0},
        "enabled": True,
    }
    grain = {
        "id": "fx_grain00001", "type": "effect", "effect": "filmGrain", "start": 0, "duration": MUSIC_DURATION,
        "params": {"amount": 0.12, "size": 1.5},
        "envelope": {"attack": 0, "hold": MUSIC_DURATION, "decay": 0, "curve": "linear"}, "enabled": True,
    }
    music_clip = clip("clp_music00001", MUSIC, 0.0, MUSIC_DURATION, 0.0, MUSIC_DURATION,
                      markers=music_markers, volume=1,
                      sections=[{"id": f"sec_{i:010d}", "start": s, "end": e, "label": lbl, "energy": en}
                                for i, (s, e, lbl, en) in enumerate(SECTIONS)])

    return {
        "schemaVersion": 1,
        "id": "prj_demo000001",
        "name": "Demo phonk edit",
        "fps": 30, "width": 1920, "height": 1080,
        "duration": MUSIC_DURATION,
        "background": "#000000",
        "assets": asset_list,
        "tracks": [
            {"id": "trk_video00001", "kind": "video", "name": "V1", "muted": False, "locked": False,
             "hidden": False, "items": video_items},
            {"id": "trk_fx00000001", "kind": "fx", "name": "FX", "muted": False, "locked": False,
             "hidden": False, "items": [grain]},
            {"id": "trk_fx00000002", "kind": "fx", "name": "FX hits", "muted": False, "locked": False,
             "hidden": False, "items": [shake]},
            {"id": "trk_audio00001", "kind": "audio", "name": "Music", "muted": False, "locked": False,
             "hidden": False, "volume": 1, "items": [music_clip]},
        ],
        "markers": [{"id": "mrk_manual0001", "t": drop, "kind": "manual", "strength": 1, "label": "DROP", "color": "#ffcc00"}],
        "sections": [],  # секции музыки — в clip.sections музыкального клипа (CONTRACT v1.4)
        "createdAt": TS, "updatedAt": TS, "revision": 3,
    }


def jobs() -> list[dict[str, Any]]:
    base = {"createdAt": TS, "updatedAt": TS}
    return [
        {"id": "job_proxy000001", "kind": "proxy", "assetId": VIDEO_A, "status": "running", "progress": 0.42,
         "message": "Прокси 720p", **base},
        {"id": "job_music000001", "kind": "musicAnalysis", "assetId": MUSIC, "status": "done", "progress": 1,
         "result": {"assetId": MUSIC, "bpm": BPM}, **base},
        {"id": "job_interp00001", "kind": "interpolate", "assetId": VIDEO_A, "status": "queued", "progress": 0, **base},
        {"id": "job_clipai00001", "kind": "clipAnalysis", "assetId": VIDEO_B, "status": "failed", "progress": 0.1,
         "error": {"code": "gemini_unavailable", "message": "GEMINI_API_KEY не задан"}, **base},
    ]


def ops_result() -> dict[str, Any]:
    return {
        "ops": [
            {"op": "addTrack", "track": {"id": "tmp_fxtrack", "kind": "fx", "name": "AI: шейк", "muted": False,
                                          "locked": False, "hidden": False}},
            {"op": "applyEffectToMarkers", "effect": "shake", "params": {"amount": 50},
             "filter": {"musicClipId": "clp_music00001", "kinds": ["bass"], "minStrength": 0.6, "sectionLabels": ["drop"]},
             "target": {"trackId": "tmp_fxtrack"}, "scaleByStrength": True},
            {"op": "setTimeRemap", "clipId": "clp_drop000001", "timeRemap": {
                "keyframes": [
                    {"u": 0, "speed": 1, "ease": "linear"},
                    {"u": 0.6, "speed": 1, "ease": "easeIn"},
                    {"u": 1, "speed": 0.2, "ease": "linear"},
                ],
                "fit": "stretch", "frameBlend": True}},
        ],
        "explanation": "Добавил дорожку эффектов, шейк на сильные басы в дропах (сильнее на сильных ударах) и замедление к концу первого клипа дропа.",
        "warnings": [],
    }


def ai_commands() -> dict[str, Any]:
    sel = {"clipIds": [], "markerIds": [], "effectIds": []}
    cmds = [
        ("shake-drop", "Поставь шейк на каждый сильный бас в дропе", sel, ["applyEffectToMarkers"]),
        ("flicker-build", "Фликер на каждый второй бит в нарастании", sel, ["applyEffectToMarkers"]),
        ("velocity-end", "Сделай velocity в конце видео: быстро-медленно-быстро на последних клипах",
         {"clipIds": ["clp_drop000002", "clp_drop000003"], "markerIds": [], "effectIds": []}, ["setTimeRemap"]),
        ("cut-to-beats", "Нарежь выделенные клипы по басам в первом дропе",
         {"clipIds": ["clp_drop000001", "clp_drop000002"], "markerIds": [], "effectIds": []}, ["cutToMarkers"]),
        ("remove-weak", "Удали слабые маркеры баса в интро", sel, ["removeMarkers"]),
        ("flash-strongest", "Белая вспышка только на самых сильных ударах", sel, ["applyEffectToMarkers"]),
        ("slow-selected", "Замедли выделенный клип к концу", {"clipIds": ["clp_drop000001"], "markerIds": [], "effectIds": []},
         ["setTimeRemap"]),
        ("zoom-punch-downbeats", "Зум-панч на каждый даунбит во втором дропе", sel, ["applyEffectToMarkers"]),
        ("transition-sections", "Добавь глитч-переходы на границах секций", sel, ["addEffect"]),
        ("ambiguous", "Сделай красиво", sel, []),
    ]
    return {
        "version": 1,
        "projectFixture": "project.json",
        "commands": [
            {"id": cid, "message": msg, "selection": s, "playhead": 30.0, "expectedOps": exp,
             **({"notes": "Неоднозначная команда: ожидается пустой ops и уточняющий вопрос в explanation."} if not exp else {})}
            for cid, msg, s, exp in cmds
        ],
    }


def effect_presets() -> list[dict[str, Any]]:
    return [
        {"id": "pst_hitcombo01", "name": "Удар: шейк + вспышка", "description": "Шейк, белая вспышка и RGB-сдвиг на удар.",
         "effects": [
             {"effect": "shake", "start": 0, "duration": 0.35, "params": {"amount": 60},
              "envelope": {"attack": 0, "hold": 0.05, "decay": 0.3, "curve": "exp"}},
             {"effect": "flash", "start": 0, "duration": 0.2, "params": {"opacity": 0.7},
              "envelope": {"attack": 0, "hold": 0.02, "decay": 0.18, "curve": "exp"}},
             {"effect": "rgbSplit", "start": 0.02, "duration": 0.25, "params": {"amount": 18},
              "envelope": {"attack": 0, "hold": 0.03, "decay": 0.22, "curve": "exp"}},
         ]},
        {"id": "pst_punchzoom1", "name": "Зум-панч мягкий",
         "effects": [
             {"effect": "zoomPunch", "start": 0, "duration": 0.3, "params": {"amount": 1.1, "motionBlur": True},
              "envelope": {"attack": 0.02, "hold": 0, "decay": 0.28, "curve": "easeOut"}},
         ]},
    ]


def main() -> None:
    rng = random.Random(SEED)
    FIX.mkdir(parents=True, exist_ok=True)
    asset_list = assets()
    ma = music_analysis(rng)
    write("health.json", {"status": "ok", "version": "0.1.0", "schemaVersion": 1, "ffmpeg": True, "rife": True,
                          "demucs": False, "gemini": True})
    write("assets.json", asset_list)
    write("music_analysis.json", ma)
    write("waveform_music.json", waveform(rng))
    write("thumbs_video_a.json", thumbs(VIDEO_A, 12.0))
    write("clip_analysis.json", clip_analysis())
    write("project.json", project(ma, asset_list))
    write("jobs.json", jobs())
    write("ops_result.json", ops_result())
    write("ai_commands.json", ai_commands())
    write("presets.json", effect_presets())


if __name__ == "__main__":
    main()
