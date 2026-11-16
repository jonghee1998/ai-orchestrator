#!/usr/bin/env python3
"""Issue #92 mobile simulation smoke test. Run after npm run build."""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import hashlib, secrets, os, tempfile, subprocess, threading, ssl, http.client, socket, time, shutil
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='issue92-browser-') as tmp:
    user,password,token=[secrets.token_hex(24) for _ in range(3)]; salt=secrets.token_bytes(16)
    digest=hashlib.scrypt(password.encode(),salt=salt,n=131072,r=8,p=1,maxmem=256*1024*1024,dklen=64).hex()
    env={'PATH':os.environ['PATH'],'NODE_ENV':'production','NEXT_TELEMETRY_DISABLED':'1','DEMO_MODE':'1','VERCEL_ENV':'preview','ADMIN_USERNAME':user,'ADMIN_PASSWORD_HASH':f'scrypt$131072$8$1${salt.hex()}${digest}','CONTROL_ADMIN_TOKEN':token}
    sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close(); log=open(Path(tmp)/'server.log','w')
    proc=subprocess.Popen([shutil.which('node') or 'node','node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',str(port)],cwd=ROOT,env=env,stdout=log,stderr=log)
    class Proxy(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def request(self):
            conn=http.client.HTTPConnection('127.0.0.1',port,timeout=30); headers={k:v for k,v in self.headers.items() if k.lower() not in ['connection','transfer-encoding']}; headers.update({'x-forwarded-proto':'https','x-forwarded-host':self.headers['Host']}); body=self.rfile.read(int(self.headers.get('content-length',0))); conn.request(self.command,self.path,body=body,headers=headers); r=conn.getresponse(); data=r.read(); self.send_response(r.status)
            for k,v in r.getheaders():
                if k.lower() not in ['transfer-encoding','connection','content-length']: self.send_header(k,v)
            self.send_header('Content-Length',str(len(data)));self.end_headers()
            if self.command!='HEAD':
                try:self.wfile.write(data)
                except (BrokenPipeError,ConnectionResetError):pass
            conn.close()
        do_GET=do_POST=do_DELETE=do_HEAD=request
    proxy=ThreadingHTTPServer(('127.0.0.1',0),Proxy); cert,key=str(Path(tmp)/'cert.pem'),str(Path(tmp)/'key.pem')
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(cert,key);proxy.socket=ctx.wrap_socket(proxy.socket,server_side=True);threading.Thread(target=proxy.serve_forever,daemon=True).start();base=f'https://127.0.0.1:{proxy.server_port}'
    try:
        for _ in range(100):
            try:
                c=http.client.HTTPConnection('127.0.0.1',port,timeout=1);c.request('GET','/api/session');r=c.getresponse();r.read();c.close()
                if r.status==200:break
            except OSError:time.sleep(.1)
        else:raise AssertionError('server readiness failed')
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'),headless=True,args=['--no-sandbox']);context=browser.new_context(ignore_https_errors=True,viewport={'width':390,'height':844},is_mobile=True,has_touch=True);page=context.new_page();errors=[];external=[];mutations=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            def route(r):
                if r.request.url.startswith(base):
                    if r.request.method not in ['GET','HEAD'] and not any(x in r.request.url for x in ['/api/session','/api/demo']):mutations.append(r.request.url)
                    r.continue_()
                else:external.append(r.request.url);r.abort()
            page.route('**/*',route);page.goto(base);page.get_by_label('아이디',exact=True).fill(user);page.get_by_label('비밀번호',exact=True).fill(password);page.get_by_label('로그인 상태 유지 (30일)',exact=True).check();page.get_by_role('button',name='로그인',exact=True).click();expect(page.get_by_text('계정 · 로그인됨',exact=False)).to_be_visible()
            out=Path(os.environ.get('MOBILE_EVIDENCE_DIR',str(Path(tempfile.gettempdir())/'issue92-mobile')));out.mkdir(parents=True,exist_ok=True)
            for width in [360,390,430]:
                page.set_viewport_size({'width':width,'height':844})
                for path,name,heading in [('/projects','projects','AI Orchestrator'),('/projects/orchestrator','project-detail','AI Orchestrator'),('/agents','ai-team','AI 팀'),('/briefing','briefing','PM 브리핑')]:
                    page.goto(base+path);expect(page.get_by_role('heading',name=heading,exact=True).first).to_be_visible();nav=page.get_by_role('navigation',name='주 메뉴');assert [x.strip() for x in nav.get_by_role('link').all_text_contents()]==['▤프로젝트','◉AI 팀','◆PM 브리핑'];assert nav.locator('a[aria-current="page"]').count()==1;assert all(x.bounding_box()['height']>=44 for x in nav.get_by_role('link').all());assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth');page.screenshot(path=str(out/f'{width}-{name}.png'),full_page=True)
            page.goto(base+'/projects/orchestrator');current=page.get_by_role('button',name='3 모바일 UI 개발 진행 중');assert current.get_attribute('aria-expanded')=='true';current.click();assert current.get_attribute('aria-expanded')=='false'
            page.goto(base+'/projects');page.get_by_role('button',name='+ 새 프로젝트').click();page.get_by_label('프로젝트명').fill('새 가상 프로젝트');page.get_by_label('목표',exact=True).fill('등록과 유지 검증');page.get_by_role('button',name='저장').click();expect(page.get_by_role('heading',name='새 가상 프로젝트')).to_be_visible();page.reload();expect(page.get_by_role('heading',name='새 가상 프로젝트')).to_be_visible()
            page.goto(base+'/projects/orchestrator');page.get_by_role('tab',name='업무 목록').click();page.get_by_role('button',name='검수 요청').click();page.get_by_role('button',name='검수 실패').click();page.get_by_role('button',name='수정 시작').click();expect(page.get_by_text('작업 중',exact=True).first).to_be_visible()
            page.goto(base+'/agents');expect(page.get_by_text('40%',exact=True).first).to_be_visible();sonnet=page.get_by_role('switch').nth(2);assert sonnet.get_attribute('aria-checked')=='false';sonnet.click();page.get_by_text('개발계 시뮬레이션 패널').click();page.get_by_role('button',name='사용량 +55%').nth(1).click();expect(page.get_by_text('사용량 정책으로 제한').first).to_be_visible();sonnet.click();page.get_by_role('button',name='가상 초기화').nth(1).click();assert sonnet.get_attribute('aria-checked')=='false';expect(page.get_by_text('수동 OFF').first).to_be_visible()
            page.goto(base+'/briefing');page.get_by_role('button',name='승인').first.click();expect(page.get_by_text('승인됨').first).to_be_visible();page.get_by_text('개발계 상태 및 시나리오').click()
            for scenario,label in [('partial-failure','일부 정보 갱신 실패'),('error','개발계 전체 오류 시나리오'),('empty','조건에 맞는 중요 브리핑이 없습니다.'),('normal','PM 브리핑')]:
                page.get_by_label('시나리오',exact=True).select_option(scenario);expect(page.get_by_text(label,exact=False).first if scenario!='normal' else page.get_by_role('heading',name=label,exact=True)).to_be_visible()
            page.reload();expect(page.get_by_role('heading',name='PM 브리핑')).to_be_visible();page.goto(base+'/');assert page.get_by_role('navigation',name='주 메뉴').locator('a[aria-current="page"]').get_attribute('href')=='/projects'
            for old,target in [('/activity','/briefing'),('/tasks','/projects'),('/progress','/projects'),('/evidence','/projects'),('/control','/agents')]:page.goto(base+old);page.wait_for_load_state('networkidle');assert page.url.split('#')[0]==base+target
            page.goto(base+'/projects');page.get_by_text('계정 · 로그인됨',exact=False).click();page.get_by_role('button',name='로그아웃',exact=True).click();expect(page.get_by_label('아이디',exact=True)).to_be_visible();assert not errors,errors;assert not external,external;assert not mutations,mutations;browser.close();print('PASS: 360/390/430px, 3 tabs, roadmap, create/persist, review/revision, usage/manual-off, decision, scenarios, legacy URLs, login/logout, no external requests or data mutations. Screenshots: '+str(out))
    finally:
        proxy.shutdown();proxy.server_close();proc.terminate()
        try:proc.wait(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
        log.close()
