from pathlib import Path
import tempfile
from cryptography.exceptions import InvalidTag
from tools.seal_config import encrypt, decrypt, write_private


def run():
    password = 'synthetic-test-passphrase'
    plain = b'fictional local configuration'
    sealed = encrypt(plain, password)
    assert decrypt(sealed, password) == plain
    assert encrypt(plain, password) != sealed
    for data, key in [(sealed, password+'wrong'), (sealed[:-1]+bytes([sealed[-1]^1]), password)]:
        try:
            decrypt(data, key)
        except InvalidTag:
            pass
        else:
            raise AssertionError('Unauthenticated plaintext returned')
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder)/'private.local'
        write_private(path, plain)
        assert path.stat().st_mode & 0o777 == 0o600
        try:
            write_private(path, b'replacement')
        except FileExistsError:
            pass
        else:
            raise AssertionError('Existing private file overwritten')
        assert path.read_bytes() == plain
    print('PASS: encryption roundtrip, randomness, authentication, permissions, no overwrite')


if __name__ == '__main__':
    run()
