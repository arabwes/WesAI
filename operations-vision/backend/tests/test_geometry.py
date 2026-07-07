"""point-in-polygon + signed distance."""

from app.vision.line_crossing import signed_distance
from app.vision.zones import point_in_polygon

SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]]


def test_point_inside_square():
    assert point_in_polygon((5, 5), SQUARE)


def test_point_outside_square():
    assert not point_in_polygon((15, 5), SQUARE)
    assert not point_in_polygon((-1, 5), SQUARE)
    assert not point_in_polygon((5, 11), SQUARE)


def test_point_in_concave_polygon():
    # U-shape: notch in the middle top
    poly = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10]]
    assert point_in_polygon((2, 8), poly)      # left arm
    assert point_in_polygon((8, 8), poly)      # right arm
    assert not point_in_polygon((5, 8), poly)  # inside the notch


def test_degenerate_polygon_is_never_inside():
    assert not point_in_polygon((5, 5), [[0, 0], [10, 10]])
    assert not point_in_polygon((5, 5), [])


def test_signed_distance_sides():
    # horizontal line left->right: below is one sign, above the other
    a, b = (0, 100), (100, 100)
    d_above = signed_distance((50, 50), a, b)
    d_below = signed_distance((50, 150), a, b)
    assert d_above * d_below < 0
    assert abs(abs(d_above) - 50) < 1e-9


def test_signed_distance_zero_length_line():
    assert signed_distance((5, 5), (1, 1), (1, 1)) == 0.0
