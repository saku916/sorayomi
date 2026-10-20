"""開発用サーバー：キャッシュを無効にして配信する。 python serve.py [ポート]"""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'http://localhost:{port}/ で起動しました（Ctrl+Cで終了）')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
