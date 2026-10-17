from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
VERSION = "0.1.0"


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def setting(name: str, default: int) -> int:
    return int(os.environ.get("LAB_" + name, default))


class LabError(Exception):
    def __init__(self, code: str, message: str, status: int = 422, **details: Any):
        self.code, self.message, self.status, self.details = code, message, status, details
        self.request_id = "req_" + uuid4().hex[:12]

    def body(self) -> dict:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
                "request_id": self.request_id,
            }
        }
