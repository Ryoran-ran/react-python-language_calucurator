from __future__ import annotations

import atexit
import json
import sqlite3
import tempfile
import threading
import weakref
from pathlib import Path

from .core import setting


class EventLog:
    """Bounded hot history with a lossless, indexed local archive."""

    def __init__(self):
        self.hot: list[dict] = []
        self.count = 0
        self.bytes = 0
        self.archived_through = 0
        self.lock = threading.RLock()
        self.directory: Path | None = None
        self.database: sqlite3.Connection | None = None

    def __len__(self):
        return self.count

    def __iter__(self):
        return iter(self.copy())

    def append(self, event: dict) -> bool:
        encoded = json.dumps(event, ensure_ascii=False, allow_nan=False)
        with self.lock:
            self.hot.append(event)
            self.count += 1
            self.bytes += len(encoded.encode("utf-8"))
            limit = max(4, setting("MAX_EVENTS", 100000))
            if len(self.hot) <= limit:
                return False
            if self.database is None:
                self.directory = Path(tempfile.mkdtemp(prefix="kotoba-events-"))
                self.database = sqlite3.connect(self.directory / "events.sqlite", check_same_thread=False)
                self.database.execute(
                    "CREATE TABLE events (sequence INTEGER PRIMARY KEY, body TEXT NOT NULL)"
                )
                reference = weakref.ref(self)

                def cleanup():
                    log = reference()
                    if log is not None:
                        log.close()

                # The log owns cleanup, so SQLite always closes before its files are removed.
                atexit.register(cleanup)
            amount = max(2, limit // 2)
            archived = self.hot[:amount]
            self.database.executemany(
                "INSERT INTO events VALUES (?, ?)",
                [(e["sequence"], json.dumps(e, ensure_ascii=False, allow_nan=False)) for e in archived],
            )
            self.database.commit()
            self.archived_through = archived[-1]["sequence"]
            del self.hot[:amount]
            return True

    def since(self, after: int = 0) -> list[dict]:
        with self.lock:
            previous = []
            if self.database is not None and after < self.archived_through:
                previous = [
                    json.loads(row[0])
                    for row in self.database.execute(
                        "SELECT body FROM events WHERE sequence > ? ORDER BY sequence", (after,)
                    )
                ]
            return previous + [e.copy() for e in self.hot if e["sequence"] > after]

    def copy(self) -> list[dict]:
        return self.since()

    def close(self):
        if self.database is not None:
            self.database.close()
            self.database = None
        if self.directory is not None:
            for name in ("events.sqlite", "events.sqlite-journal", "events.sqlite-wal", "events.sqlite-shm"):
                (self.directory / name).unlink(missing_ok=True)
            self.directory.rmdir()
            self.directory = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
