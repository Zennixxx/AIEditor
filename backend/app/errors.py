"""Единый формат ошибок: {"error": {"code", "message", "details"}} — CONTRACT §1."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiException(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def _body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if details:
        err["details"] = details
    return {"error": err}


_STATUS_CODES = {400: "bad_request", 404: "not_found", 405: "method_not_allowed", 409: "conflict"}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiException)
    async def _api(_: Request, exc: ApiException) -> JSONResponse:
        return JSONResponse(_body(exc.code, exc.message, exc.details), status_code=exc.status)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "http_error")
        return JSONResponse(_body(code, str(exc.detail)), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = {"errors": jsonable_encoder(exc.errors())}
        return JSONResponse(_body("validation_error", "Некорректный запрос", details), status_code=422)
