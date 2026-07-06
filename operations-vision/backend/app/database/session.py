"""Engine + session factory.

SQLite in WAL mode so the pipeline writer and API readers don't block
each other. The engine is created lazily from settings so tests can
point OPSVISION_DATABASE_URL at a temp file before first use.
"""

from __future__ import annotations

import threading
from typing import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import load_app_settings

_lock = threading.Lock()
_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def _configure_sqlite(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _set_pragmas(dbapi_conn, _record):  # noqa: ANN001
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


def get_engine() -> Engine:
    global _engine, _session_factory
    with _lock:
        if _engine is None:
            url = load_app_settings().resolved_database_url()
            connect_args = {}
            if url.startswith("sqlite"):
                connect_args["check_same_thread"] = False
            _engine = create_engine(url, connect_args=connect_args, pool_pre_ping=True)
            if url.startswith("sqlite"):
                _configure_sqlite(_engine)
            _session_factory = sessionmaker(
                bind=_engine, expire_on_commit=False, autoflush=False
            )
        return _engine


def reset_engine() -> None:
    """For tests: drop the cached engine so the next call re-reads env."""
    global _engine, _session_factory
    with _lock:
        if _engine is not None:
            _engine.dispose()
        _engine = None
        _session_factory = None


def session_factory() -> sessionmaker[Session]:
    get_engine()
    assert _session_factory is not None
    return _session_factory


def new_session() -> Session:
    return session_factory()()


def get_db() -> Iterator[Session]:
    """FastAPI dependency."""
    db = new_session()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables that don't exist yet (Alembic owns real migrations)."""
    from app.database.models import Base

    Base.metadata.create_all(get_engine())
