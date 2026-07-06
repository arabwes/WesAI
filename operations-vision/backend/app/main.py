"""FastAPI application entry point."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.core.config import load_app_settings
from app.core.logging import setup_logging

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_app_settings()
    setup_logging(settings.log_level)

    from app.database.session import init_db

    init_db()

    manager = None
    if os.environ.get("OPSVISION_DISABLE_PIPELINE") != "1":
        from app.pipeline.manager import PipelineManager, set_manager

        manager = PipelineManager(settings)
        set_manager(manager)
        await manager.start()

    log.info("operations-vision %s up (demo=%s)", __version__, settings.demo.enabled)
    yield

    if manager is not None:
        from app.pipeline.manager import set_manager

        await manager.stop()
        set_manager(None)


def create_app() -> FastAPI:
    settings = load_app_settings()
    app = FastAPI(
        title="Operations Vision",
        version=__version__,
        description="Anonymous multi-camera business operations platform",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.server.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Frame-Width", "X-Frame-Height"],
    )

    from app.api import analytics, calibration, cameras, events, health, visits

    app.include_router(health.router)
    app.include_router(cameras.router)
    app.include_router(events.router)
    app.include_router(visits.router)
    app.include_router(analytics.router)
    app.include_router(calibration.router)
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    settings = load_app_settings()
    uvicorn.run(app, host=settings.server.host, port=settings.server.port)
