"""Static fictional archive preview. It never accesses Yandex or local cookies."""
from pathlib import Path
from demo_server import serve


if __name__ == '__main__':
    serve(Path(__file__).resolve().parents[1]/'demo/static',lambda path:None)
