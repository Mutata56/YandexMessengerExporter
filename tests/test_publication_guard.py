import struct
import zlib

from tools.check_public_tree import PNG_SIGNATURE, check_path, check_screenshot, check_text


def test_private_configuration_and_runtime_paths_are_blocked():
    for path in ["config/secrets.local.json", "config/config.json", "config/config.json.bak", "state/drafts/1.json", "logs/app.log", "CLAUDE_SESSIONS.md", "config/private/config.example.json"]:
        assert check_path(path)


def test_public_templates_are_allowed():
    assert check_path("config/config.example.json") is None
    assert check_path("config/secrets.example.json") is None
    assert check_path("agent/orchestrator.py") is None


def test_private_addresses_are_blocked_without_disclosing_values():
    value = ".".join(["10", "1", "2", "3"])
    assert check_text(value) == ["non_example_ip"]
    assert check_text("http://" + "internal-service" + ".corp") == ["non_public_service_host"]
    assert check_text("person@" + "internal-service" + ".corp") == ["non_example_email"]


def test_public_examples_and_localhost_are_allowed():
    assert check_text("https://redmine.example.invalid 192.0.2.10 engineer@example.invalid http://127.0.0.1:8765") == []


def png_chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))


def sample_png(extra=b""):
    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    pixels = zlib.compress(b"\x00\x00\x00\x00\xff")
    return PNG_SIGNATURE + png_chunk(b"IHDR", header) + extra + png_chunk(b"IDAT", pixels) + png_chunk(b"IEND", b"")


def test_reviewed_png_paths_are_allowed_but_other_images_are_not():
    assert check_screenshot("documentation/screenshots/archive.png", sample_png()) == []
    assert check_screenshot("documentation/screenshots/private.png", sample_png()) == ["unexpected_binary_file"]
    assert check_screenshot("documentation/screenshots/archive.png", b"renamed document") == ["invalid_screenshot_png"]


def test_screenshot_metadata_is_rejected():
    for kind in (b"tEXt", b"iTXt", b"zTXt", b"eXIf"):
        image = sample_png(png_chunk(kind, b"unreviewed metadata"))
        assert check_screenshot("documentation/screenshots/attachments.png", image) == ["unexpected_png_metadata"]


def test_corrupt_or_appended_screenshot_data_is_rejected():
    image = sample_png()
    for invalid in (image[:-1], image + b"appended private text", image[:40] + b"broken" + image[46:]):
        assert check_screenshot("documentation/screenshots/attachments.png", invalid) == ["invalid_screenshot_png"]
