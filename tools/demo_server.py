"""Static, read-only demo server. It imports no application or integration code."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import mimetypes


def serve(static, fixture, asset_prefix=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ready-file', type=Path)
    args = parser.parse_args()
    static = Path(static).resolve()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, body, content_type, status=200):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'")
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path.startswith('/api/'):
                value = fixture(path)
                return self.send(json.dumps(value if value is not None else {'error':'Endpoint unavailable in demo'}, ensure_ascii=False).encode(), 'application/json; charset=utf-8', 200 if value is not None else 404)
            if asset_prefix and path.startswith(asset_prefix):
                path = '/' + path[len(asset_prefix):]
            target = (static / (unquote(path).lstrip('/') or 'index.html')).resolve()
            if not target.is_relative_to(static) or not target.is_file():
                return self.send(b'Not found', 'text/plain', 404)
            data = target.read_bytes()
            if target.suffix == '.html':
                badge = '<div style="position:fixed;right:16px;bottom:12px;z-index:9999999;background:#152331;color:#eef7fa;border:1px solid #73808e;padding:8px 12px;border-radius:8px;font:12px sans-serif">ДЕМО · вымышленные данные · только просмотр</div>'
                data = data.replace(b'</body>', badge.encode() + b'</body>')
            self.send(data, mimetypes.guess_type(target.name)[0] or 'application/octet-stream')

        do_HEAD = do_GET

        def do_POST(self):
            self.send(b'{"error":"Read-only demo; integrations and writes are disabled"}', 'application/json', 405)

        do_PUT = do_POST
        do_PATCH = do_POST
        do_DELETE = do_POST

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    url = f'http://127.0.0.1:{server.server_port}'
    if args.ready_file:
        args.ready_file.write_text(json.dumps({'url':url,'read_only':True,'synthetic_data':True}))
    print(url, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
