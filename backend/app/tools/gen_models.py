"""Генерация Pydantic-моделей из shared/schema → app/models/gen.py.

Схемы project.schema.json и api.schema.json сливаются в один документ (ссылки
"project.schema.json#/definitions/X" переписываются на локальные), затем
прогоняются через datamodel-code-generator. После генерации явные camelCase-алиасы
заменяются на alias_generator=to_camel (см. use_alias_generator).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = ROOT / "shared" / "schema"
OUT = ROOT / "backend" / "app" / "models" / "gen.py"
SCHEMA_FILES = ["project.schema.json", "api.schema.json"]
HEADER = "# Сгенерировано из shared/schema командой `uv run gen-models`. Не редактировать вручную."


def _rewrite_refs(node: Any) -> Any:
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k == "$ref" and isinstance(v, str) and "#/definitions/" in v:
                out[k] = "#/definitions/" + v.split("#/definitions/", 1)[1]
            else:
                out[k] = _rewrite_refs(v)
        return out
    if isinstance(node, list):
        return [_rewrite_refs(v) for v in node]
    return node


def merged_schema() -> dict[str, Any]:
    definitions: dict[str, Any] = {}
    for name in SCHEMA_FILES:
        doc = json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))
        for key, value in doc.get("definitions", {}).items():
            if key in definitions:
                raise SystemExit(f"duplicate definition {key!r} in {name}")
            definitions[key] = _rewrite_refs(value)
    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "AIEditorSchema",
        "definitions": definitions,
    }


_FIELD_RE = re.compile(r"^    (\w+): ")
_ALIAS_RE = re.compile(r',?\s*alias="(\w+)"')


def use_alias_generator(code: str) -> str:
    """Явные alias="camelCase" → alias_generator=to_camel в model_config.

    Так pyright видит в конструкторах snake_case-имена полей, а JSON остаётся
    camelCase. Явный alias остаётся только там, где to_camel(поле) != alias.
    """
    from pydantic.alias_generators import to_camel

    out: list[str] = []
    field: str | None = None
    for line in code.splitlines():
        m = _FIELD_RE.match(line)
        if m:
            field = m.group(1)
        if field is not None:
            am = _ALIAS_RE.search(line)
            if am and to_camel(field) == am.group(1):
                line = _ALIAS_RE.sub("", line, count=1)
                if line.strip() in ("", ","):
                    continue  # alias стоял отдельной строкой
        if line.strip() == "populate_by_name=True,":
            out.append(line)
            line = line.replace("populate_by_name=True,", "alias_generator=to_camel,")
        out.append(line)
    text = "\n".join(out) + "\n"
    return text.replace(
        "from pydantic import ", "from pydantic.alias_generators import to_camel\nfrom pydantic import ", 1
    )


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "aieditor.schema.json"
        src.write_text(json.dumps(merged_schema(), ensure_ascii=False), encoding="utf-8")
        cmd = [
            sys.executable,
            "-m",
            "datamodel_code_generator",
            "--input",
            str(src),
            "--input-file-type",
            "jsonschema",
            "--output",
            str(OUT),
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--target-python-version",
            "3.12",
            "--snake-case-field",
            "--allow-population-by-field-name",
            "--use-standard-collections",
            "--use-union-operator",
            "--use-double-quotes",
            "--use-schema-description",
            "--field-constraints",
            "--enum-field-as-literal",
            "all",
            "--use-one-literal-as-default",
            "--disable-timestamp",
            "--use-type-alias",
            "--formatters",
            "ruff-format",
            "ruff-check",
            "--custom-file-header",
            HEADER,
        ]
        subprocess.run(cmd, check=True)
    OUT.write_text(use_alias_generator(OUT.read_text(encoding="utf-8")), encoding="utf-8", newline="\n")
    subprocess.run(
        [sys.executable, "-m", "ruff", "format", "--quiet", "--isolated", "--line-length", "110", str(OUT)],
        check=True,
    )
    print(f"written {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
