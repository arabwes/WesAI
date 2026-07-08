"""Appearance features: privacy-bound TTL store + similarity."""

import numpy as np
import pytest

from app.identity.appearance import (
    AppearanceStore,
    appearance_similarity,
    extract_appearance,
)


def solid_frame(color, w=200, h=300):
    frame = np.zeros((h, w, 3), dtype=np.uint8)
    frame[:] = color
    return frame


def test_extract_appearance_shape_and_norm():
    v = extract_appearance(solid_frame((0, 0, 255)), (50, 50, 150, 250))
    assert v is not None
    assert v.dtype == np.float32
    assert v.sum() == pytest.approx(2.0, abs=1e-3)  # 2 normalized bands


def test_extract_rejects_tiny_crops():
    assert extract_appearance(solid_frame((0, 0, 255)), (0, 0, 4, 8)) is None


def test_same_colors_similar_different_colors_not():
    red = extract_appearance(solid_frame((0, 0, 255)), (50, 50, 150, 250))
    red2 = extract_appearance(solid_frame((0, 0, 250)), (50, 50, 150, 250))
    green = extract_appearance(solid_frame((0, 255, 0)), (50, 50, 150, 250))
    assert appearance_similarity(red, red2) > 0.9
    assert appearance_similarity(red, green) < 0.3


def test_similarity_none_when_missing():
    v = extract_appearance(solid_frame((0, 0, 255)), (50, 50, 150, 250))
    assert appearance_similarity(None, v) is None


def test_store_ttl_expiry():
    store = AppearanceStore(retention_minutes=-0.01)  # already expired on insert
    v = np.ones(4, dtype=np.float32)
    store.put("cam:1", v)
    assert store.get("cam:1") is None
    store.put("cam:2", v)
    assert store.purge_expired() == 1
    assert len(store) == 0


def test_store_holds_within_ttl():
    store = AppearanceStore(retention_minutes=5)
    v = np.ones(4, dtype=np.float32)
    store.put("cam:1", v)
    assert store.get("cam:1") is not None
    store.drop("cam:1")
    assert store.get("cam:1") is None
