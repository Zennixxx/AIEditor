"""Копилот `/ai/command` — docs/BACKEND.md §7.4.

Ответ Gemini (`gemini_ops.GeminiCommandResponse`) переводится в строгие EditOp и прогоняется
на копии проекта.
При ошибках — одна повторная попытка с их текстом; если и она не прошла, невалидные ops
отбрасываются по одному (вместе с зависящими от них), а причины уходят в `warnings`.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.ai.client import LLM, LLMError, TextPart
from app.ai.gemini_ops import ConversionError, ConvertContext, GeminiCommandResponse, convert
from app.ai.summarize import summarize
from app.ai.timeline import OpsError
from app.ai.validate_ops import AssetResolver, DryRun
from app.effects.registry import Registry
from app.models.gen import AICommandRequest, RampPreset, RampPresetsFile
from app.models.ops import StrictEditOp, dump_op
from app.storage.atomic import read_json

log = logging.getLogger(__name__)

PROMPT_VERSION = "command-2"
SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "command.md").read_text(encoding="utf-8")


def load_ramp_presets(shared_dir: Path) -> list[RampPreset]:
    try:
        return RampPresetsFile.model_validate(
            read_json(shared_dir / "fixtures" / "ramp_presets.json")
        ).presets
    except (FileNotFoundError, ValueError) as exc:
        log.error("Пресеты speed ramp не загружены: %s", exc)
        return []


@dataclass
class Evaluation:
    ops: list[StrictEditOp] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class CommandResult:
    ops: list[StrictEditOp]
    explanation: str
    warnings: list[str]

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ops": [dump_op(op) for op in self.ops], "explanation": self.explanation}
        if self.warnings:
            out["warnings"] = self.warnings
        return out


class CopilotService:
    def __init__(
        self, registry: Registry, ramp_presets: list[RampPreset], resolve_asset: AssetResolver
    ) -> None:
        self.registry = registry
        self.ramp_presets = ramp_presets
        self.resolve_asset = resolve_asset

    def evaluate(
        self, resp: GeminiCommandResponse, req: AICommandRequest, *, skip_invalid: bool
    ) -> Evaluation:
        dry = DryRun(req.project.model_copy(deep=True), self.registry, self.resolve_asset)
        ctx = ConvertContext(
            dry, self.registry, {p.id: p for p in self.ramp_presets}, list(req.selection.clip_ids)
        )
        result = Evaluation()
        for i, g in enumerate(resp.ops):
            saved = (dry.project.model_copy(deep=True), set(dry.ids), dict(dry.id_map), len(ctx.warnings))
            try:
                op = convert(ctx, g)
                dry.apply(op)
            except (ConversionError, OpsError) as exc:
                msg = exc.message if isinstance(exc, OpsError) else str(exc)
                code = f" [{exc.code}]" if isinstance(exc, OpsError) else ""
                result.errors.append(f"op #{i + 1} ({g.op}){code}: {msg}")
                if skip_invalid:
                    dry.project, dry.ids, dry.id_map = saved[0], saved[1], saved[2]
                    del ctx.warnings[saved[3] :]
                continue
            result.ops.append(op)
        violations = dry.finalize()
        if violations:
            result.errors += [f"итоговый проект нарушает инвариант: {v}" for v in violations[:10]]
            if skip_invalid:
                result.ops = []
        result.warnings = ctx.warnings
        return result

    def _parts(self, req: AICommandRequest) -> list[TextPart]:
        context = json.dumps(
            summarize(req, self.registry, self.ramp_presets), ensure_ascii=False, separators=(",", ":")
        )
        parts = [TextPart(f"PROJECT:\n{context}")]
        if req.history:
            lines = [f"{'Пользователь' if h.role == 'user' else 'Ассистент'}: {h.text}" for h in req.history]
            parts.append(TextPart("ИСТОРИЯ ДИАЛОГА:\n" + "\n".join(lines)))
        parts.append(TextPart(f"КОМАНДА: {req.message}"))
        return parts

    async def _generate(self, llm: LLM, parts: list[TextPart]) -> GeminiCommandResponse:
        return await llm.generate(
            GeminiCommandResponse, parts, system=SYSTEM_PROMPT, tier="fast", prompt_version=PROMPT_VERSION
        )

    async def run(self, llm: LLM, req: AICommandRequest) -> CommandResult:
        parts = self._parts(req)
        resp = await self._generate(llm, parts)
        first = self.evaluate(resp, req, skip_invalid=False)
        if not first.errors:
            return CommandResult(first.ops, resp.explanation, first.warnings)

        log.info("Копилот: %d ошибок в ответе, повторный запрос", len(first.errors))
        retry_parts = [
            *parts,
            TextPart("ТВОЙ ПРЕДЫДУЩИЙ ОТВЕТ:\n" + resp.model_dump_json(exclude_none=True)),
            TextPart(
                "ОШИБКИ ПРОВЕРКИ (операции не применены):\n"
                + "\n".join(f"- {e}" for e in first.errors)
                + "\nИсправь ответ и верни полный список ops заново."
            ),
        ]
        try:
            final_resp = await self._generate(llm, retry_parts)
        except LLMError as exc:
            log.warning("Копилот: повторный запрос не удался: %s", exc.message)
            final_resp = resp
        final = self.evaluate(final_resp, req, skip_invalid=True)
        warnings = final.warnings + [f"Пропущено: {e}" for e in final.errors]
        return CommandResult(final.ops, final_resp.explanation, warnings)
