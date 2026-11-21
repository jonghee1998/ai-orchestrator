#!/usr/bin/env python3
"""After npm run build: local HTTPS mobile regression using only disposable sample credentials.
Requires Python Playwright, Chromium, OpenSSL. No external services or deployment.
"""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import hashlib, secrets, os, tempfile, subprocess, threading, ssl, http.client, socket, time, shutil
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='issue90-browser-') as tmp:
    user, password, token = [secrets.token_hex(24) for _ in range(3)]
    salt=secrets.token_bytes(16)
    digest=hashlib.scrypt(password.encode(),salt=salt,n=131072,r=8,p=1,maxmem=256*1024*1024,dklen=64).hex()
    env={'PATH':os.environ['PATH'],'NODE_ENV':'production','NEXT_TELEMETRY_DISABLED':'1','DEMO_MODE':'1','VERCEL_ENV':'preview','ADMIN_USERNAME':user,'ADMIN_PASSWORD_HASH':f'scrypt$131072$8$1${salt.hex()}${digest}','CONTROL_ADMIN_TOKEN':token}
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
    log=open(Path(tmp)/'server.log','w')
    proc=subprocess.Popen([shutil.which('node') or 'node','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',str(port)],cwd=ROOT,env=env,stdout=log,stderr=log)
    class Proxy(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def handle_request(self):
            conn=http.client.HTTPConnection('127.0.0.1',port,timeout=30)
            headers={k:v for k,v in self.headers.items() if k.lower() not in ['connection','transfer-encoding']}
            headers['x-forwarded-proto']='https'
            headers['x-forwarded-host']=self.headers['Host']
            body=self.rfile.read(int(self.headers.get('content-length',0)))
            conn.request(self.command,self.path,body=body,headers=headers)
            r=conn.getresponse(); data=r.read()
            self.send_response(r.status)
            for k,v in r.getheaders():
                if k.lower() not in ['transfer-encoding','connection','content-length']:
                    self.send_header(k,v)
            self.send_header('Content-Length',str(len(data)));self.end_headers()
            try:
                if self.command!='HEAD': self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError): pass
            conn.close()
        do_GET=do_POST=do_DELETE=do_HEAD=handle_request
    proxy=ThreadingHTTPServer(('127.0.0.1',0),Proxy)
    cert,key=str(Path(tmp)/'cert.pem'),str(Path(tmp)/'key.pem')
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(cert,key)
    proxy.socket=ctx.wrap_socket(proxy.socket,server_side=True)
    thread=threading.Thread(target=proxy.serve_forever,daemon=True);thread.start()
    base=f'https://127.0.0.1:{proxy.server_port}'
    try:
        for i in range(100):
            try:
                c=http.client.HTTPConnection('127.0.0.1',port,timeout=1);c.request('GET','/api/session');r=c.getresponse();r.read();c.close()
                if r.status==200: break
            except OSError: time.sleep(.1)
        else: raise AssertionError('test server failed readiness')
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
            context=browser.new_context(ignore_https_errors=True,viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
            page=context.new_page();errors=[];external=[];mutations=[]
            page.on('pageerror',lambda err: errors.append(str(err)))
            def route(r):
                if r.request.url.startswith(base):
                    if r.request.method not in ['GET','HEAD'] and not any(x in r.request.url for x in ['/api/session','/api/demo']): mutations.append(r.request.url)
                    r.continue_()
                else: external.append(r.request.url);r.abort()
            page.route('**/*',route)
            page.goto(base)
            page.get_by_label('아이디',exact=True).fill(user);page.get_by_label('비밀번호',exact=True).fill(password)
            page.get_by_label('로그인 상태 유지 (30일)',exact=True).check()
            page.get_by_role('button',name='로그인',exact=True).click()
            expect(page.get_by_text('계정 · 로그인됨',exact=False)).to_be_visible()
            out=Path(os.environ.get('MOBILE_EVIDENCE_DIR', str(Path(tempfile.gettempdir())/'issue90-mobile')));out.mkdir(parents=True,exist_ok=True)
            for width in [360,390,430]:
                page.set_viewport_size({'width':width,'height':844})
                for path,name in [('/','home'),('/projects','projects'),('/agents','agents'),('/activity','activity')]:
                    page.goto(base+path)
                    expect(page.get_by_test_id('project-sample-dashboard').first if path in ['/','/projects'] else page.get_by_role('heading',name='에이전트',exact=True) if path=='/agents' else page.get_by_role('heading',name='활동',exact=True)).to_be_visible()
                    page.wait_for_load_state('networkidle')
                    nav=page.get_by_role('navigation',name='주 메뉴')
                    assert nav.get_by_role('link').all_text_contents()==['◆홈','▤프로젝트','◉에이전트','↻활동'] or [x.strip() for x in nav.get_by_role('link').all_text_contents()]==['◆홈','▤프로젝트','◉에이전트','↻활동']
                    assert nav.locator('a[aria-current="page"]').count()==1
                    assert all(x.bounding_box()['height']>=44 for x in nav.get_by_role('link').all())
                    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), (width,path,'horizontal overflow')
                    page.screenshot(path=str(out/f'{width}-{name}.png'))
                    page.screenshot(path=str(out/f'{width}-{name}-full.png'),full_page=True)
                    page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
                    last=page.locator('main > div > :last-child').bounding_box()
                    assert last['y']+last['height'] <= nav.bounding_box()['y']-8, (width,path,'bottom content obscured')
                page.goto(base+'/projects/sample-support')
                expect(page.get_by_role('heading',name='고객 상담 도우미',exact=True).first).to_be_visible()
                page.get_by_test_id('task-903').first.click()
                expect(page.get_by_role('heading',name='상담 답변 초안 검수',exact=True)).to_be_visible()
                expect(page.get_by_role('heading',name='결과 및 검수 자료')).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                page.screenshot(path=str(out/f'{width}-task.png'),full_page=True)
            page.goto(base+'/agents')
            page.get_by_text('에이전트 상세 · 배정 설정',exact=True).click()
            expect(page.get_by_text('샘플 배정 정책입니다.',exact=False)).to_be_visible()
            for b in page.locator('#assignment-settings button').all():
                if b.inner_text()!='새로고침': assert b.is_disabled(), b.inner_text()
            page.goto(base+'/')
            for scenario in ['partial-failure','error','empty','normal']:
                banner=page.get_by_test_id('demo-banner')
                if not banner.locator('details').get_attribute('open') is not None: banner.locator('summary').click()
                with page.expect_response(lambda r:'/api/work-queue' in r.url and r.request.method=='GET') as response:
                    banner.get_by_role('combobox').select_option(scenario)
                assert response.value.status == (502 if scenario=='partial-failure' else 500 if scenario=='error' else 200)
                if scenario=='empty': expect(page.get_by_text('등록된 프로젝트와 작업이 없습니다').first).to_be_visible()
                if scenario in ['partial-failure','error']:
                    expect(page.get_by_role('status').first).to_be_visible()
                    expect(page.get_by_test_id('project-sample-dashboard')).to_be_visible()
                if scenario=='normal': expect(page.get_by_test_id('project-sample-dashboard')).to_be_visible()
                page.screenshot(path=str(out/f'390-{scenario}.png'),full_page=True)
            page.reload();expect(page.get_by_text('계정 · 로그인됨',exact=False)).to_be_visible()
            with page.expect_response(lambda r:'/api/work-queue' in r.url and r.request.method=='GET'):
                page.get_by_role('button',name='전체 새로고침').click()
            expect(page.get_by_test_id('refresh-time')).to_contain_text('KST')
            for old,target in [('/tasks','/projects'),('/progress','/projects'),('/evidence','/projects'),('/control','/agents')]:
                page.goto(base+old);page.wait_for_load_state('networkidle');assert page.url.split('#')[0]==base+target
            page.goto(base)
            page.get_by_text('계정 · 로그인됨',exact=False).click()
            page.get_by_role('button',name='로그아웃',exact=True).click()
            expect(page.get_by_label('아이디',exact=True)).to_be_visible()
            assert not errors, errors
            assert not external, external
            assert not mutations, mutations
            browser.close()
            print('PASS: 360/390/430px, four tabs, project/task detail, sample controls disabled, four scenarios, login/reload/logout, KST/refresh, legacy URLs, no external requests/data mutations/page errors. Screenshots: '+str(out))
    finally:
        proxy.shutdown();proxy.server_close();proc.terminate()
        try: proc.wait(timeout=10)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()
        log.close()
