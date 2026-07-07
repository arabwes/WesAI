import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Isolated database + config dir per test."""
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setenv("OPSVISION_DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    monkeypatch.setenv("OPSVISION_CONFIG_DIR", str(config_dir))
    monkeypatch.setenv("OPSVISION_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("OPSVISION_DISABLE_PIPELINE", "1")

    from app.database.session import init_db, reset_engine

    reset_engine()
    init_db()
    yield tmp_path
    reset_engine()


@pytest.fixture()
def db(env):
    from app.database.session import new_session

    session = new_session()
    yield session
    session.close()
