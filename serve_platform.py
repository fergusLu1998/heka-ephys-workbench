"""Loopback-only static workbench and local folder-update API."""
import argparse,json
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit
from ephys_library import Library,OUT,ROOT
from assets import prepare

library=Library()
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(OUT),**kwargs)
    def allowed(self):return self.headers.get('Host') in {f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'}
    def send_json(self,payload,status=200):
        data=json.dumps(payload,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def end_headers(self):
        if self.path.endswith('.html'):self.send_header('Cache-Control','no-cache')
        super().end_headers()
    def do_GET(self):
        if not self.allowed():return self.send_json({'error':'Invalid local host'},403)
        path=urlsplit(self.path).path
        if path=='/api/library/config':return self.send_json(library.config())
        if path=='/api/library/status':return self.send_json(library.status())
        return super().do_GET()
    def do_POST(self):
        origin=self.headers.get('Origin');expected=f"http://{self.headers.get('Host')}"
        if not self.allowed() or (origin and origin!=expected) or self.headers.get('X-Ephys-Request')!='1' or self.headers.get_content_type()!='application/json':return self.send_json({'error':'Only same-origin local workbench requests are accepted'},403)
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<16384:raise ValueError('Invalid request size')
            body=json.loads(self.rfile.read(length));folder=body.get('folder','')
            if self.path=='/api/library/scan':result=library.scan(folder)
            elif self.path=='/api/library/update':result=library.start(folder)
            else:return self.send_json({'error':'Unknown endpoint'},404)
            self.send_json(result)
        except Exception as error:self.send_json({'error':str(error)},400)
    def log_message(self,*args):pass

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8765);args=parser.parse_args()
    with ThreadingHTTPServer(('127.0.0.1',args.port),Handler) as server:
        prepare(ROOT,OUT)
        server.serve_forever()
