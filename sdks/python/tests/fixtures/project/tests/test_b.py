from example.b import value


def test_b() -> None:
    assert value() == "b"
