"""Encrypt local files with a terminal passphrase; never pass secrets in argv."""
import argparse
import getpass
import os
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b'LOCAL-CONFIG-V1\x00'


def derive(password, salt):
    return Scrypt(salt=salt, length=32, n=2**17, r=8, p=1).derive(password.encode())


def encrypt(data, password):
    if len(password) < 12:
        raise ValueError('Use a passphrase of at least 12 characters')
    salt, nonce = os.urandom(16), os.urandom(12)
    header = MAGIC + salt + nonce
    return header + AESGCM(derive(password, salt)).encrypt(nonce, data, header)


def decrypt(data, password):
    start = len(MAGIC)
    if not data.startswith(MAGIC) or len(data) < start + 44:
        raise ValueError('Invalid encrypted file')
    salt, nonce = data[start:start+16], data[start+16:start+28]
    header = data[:start+28]
    return AESGCM(derive(password, salt)).decrypt(nonce, data[start+28:], header)


def write_private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['encrypt','decrypt'])
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.input.resolve() == args.output.resolve():
        raise SystemExit('Input and output must differ')
    password = getpass.getpass('Local encryption passphrase: ')
    if args.operation == 'encrypt' and password != getpass.getpass('Repeat passphrase: '):
        raise SystemExit('Passphrases do not match')
    try:
        data = (encrypt if args.operation == 'encrypt' else decrypt)(args.input.read_bytes(), password)
        write_private(args.output, data)
    except InvalidTag:
        raise SystemExit('Wrong passphrase or modified encrypted file; no output written')
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
    print('Created local private file. Keep it outside Git.')


if __name__ == '__main__':
    main()
