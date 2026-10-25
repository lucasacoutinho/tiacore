from example.a import value


def test_a() -> None:
    assert value() == "a"
