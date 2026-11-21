#!/usr/bin/env python3
"""Issue #116 live read-only mobile smoke (WorkspaceModel v1). Real server with real admin login; GitHub/runtime APIs are mocked in the browser. Run after npm run build."""
from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import json, hashlib, secrets, os, tempfile, subprocess, threading, ssl, http.client, socket, time, shutil
from urllib.parse import quote
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler


def route_variants(i):
    # Real project ids contain ':' and Unicode: test encodeURIComponent form, browser-encoded literal form and raw colon form.
    return [quote(i,safe=''),quote(i,safe=':'),quote(i,safe=':').replace('%3A',':')]
def T(m): return '2026-11-16T%02d:%02d:00Z'%(m//60,m%60)
def issue(n,title,state,status,agent,extra=None):
    d=dict(number=n,title=title,url='https://github.com/example/repo/issues/%d'%n,state=state,agent=agent,status=status,acks=[],completions=[],comments=0,pulls=[],nextAction=dict(code='x',label='다음',actor='pm'))
    d.update(extra or {});return d
PA=dict(id='label:알파 프로젝트',name='알파 프로젝트')
PM=dict(id='milestone:7',name='마일스톤 일곱',goal='실제 목표 문장')
TASKS=[
 dict(id='1',title='완료 업무',agent='claude',status='status:done',dependsOn=[],url='https://github.com/example/repo/issues/1',issueState='closed',stateReason='completed',description='Completion type: nondeploy',project=PA),
 dict(id='2',title='진행 업무 상태 라벨만',agent='opus',status='status:in-progress',dependsOn=[],url='https://github.com/example/repo/issues/2',issueState='open',project=PA),
 dict(id='4',title='마일스톤 업무',agent='codex',status='status:ready',dependsOn=[],url='https://github.com/example/repo/issues/4',issueState='open',project=PM),
 dict(id='3',title='프로젝트 없는 업무',agent='codex',status='status:ready',dependsOn=[],url='',issueState='open'),
]
EVID=dict(source='github',repo='example/repo',generatedAt=T(600),runtimeProof='not_included',identityNote='note',limits=dict(issues=4,pulls=0,comments=0,commentsTruncated=False,pullsTruncated=False,detailedPulls=0,issuesTruncated=False),issues=[issue(1,'완료 업무','closed','done','claude'),issue(2,'진행 업무 상태 라벨만','open','in-progress','opus'),issue(3,'프로젝트 없는 업무','open','ready','codex'),issue(4,'마일스톤 업무','open','ready','codex')])
DASH=dict(mode='live',generatedAt=T(600),agents=[dict(key='codex',enabled=True,effective=True,running=0,queued=0,held=0,lastHeartbeat=None,lastAck=None),dict(key='claude-sonnet',enabled=False,effective=False,running=0,queued=0,held=0,lastHeartbeat=None,lastAck=None)],runs=[],audit=[])
LIVE={'/api/work-queue':(200,dict(mode='live',tasks=TASKS)),'/api/evidence':(200,dict(mode='live',report=EVID)),'/api/dashboard':(200,DASH)}
UNCONF={'/api/work-queue':(200,dict(mode='unconfigured')),'/api/evidence':(200,dict(mode='unconfigured')),'/api/dashboard':(200,dict(mode='unconfigured'))}
PARTIAL=dict(LIVE);PARTIAL['/api/evidence']=(200,dict(mode='unconfigured'));PARTIAL['/api/dashboard']=(500,{})
MOCKS={}
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='issue92-browser-') as tmp:
    user,password,token=[secrets.token_hex(24) for _ in range(3)]; salt=secrets.token_bytes(16)
    digest=hashlib.scrypt(password.encode(),salt=salt,n=131072,r=8,p=1,maxmem=256*1024*1024,dklen=64).hex()
    env={'PATH':os.environ['PATH'],'NODE_ENV':'production','NEXT_TELEMETRY_DISABLED':'1','VERCEL_ENV':'preview','ADMIN_USERNAME':user,'ADMIN_PASSWORD_HASH':f'scrypt$131072$8$1${salt.hex()}${digest}','CONTROL_ADMIN_TOKEN':token}
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
                path=r.request.url.replace(base,'').split('?')[0]
                if r.request.url.startswith(base) and path in MOCKS and MOCKS[path] is not None:
                    r.fulfill(status=MOCKS[path][0],content_type='application/json',body=json.dumps(MOCKS[path][1]));return
                if r.request.url.startswith(base):
                    if r.request.method not in ['GET','HEAD'] and not any(x in r.request.url for x in ['/api/session']):mutations.append(r.request.url)
                    r.continue_()
                else:external.append(r.request.url);r.abort()
            page.route('**/*',route);page.goto(base);page.get_by_label('아이디',exact=True).fill(user);page.get_by_label('비밀번호',exact=True).fill(password);page.get_by_label('로그인 상태 유지 (30일)',exact=True).check();page.get_by_role('button',name='로그인',exact=True).click();expect(page.get_by_text('계정 · 로그인됨',exact=False)).to_be_visible()
            out=Path(os.environ.get('MOBILE_EVIDENCE_DIR',str(Path(tempfile.gettempdir())/'issue116-mobile')));out.mkdir(parents=True,exist_ok=True)
            nav=lambda:[x.strip() for x in page.get_by_role('navigation',name='주 메뉴').get_by_role('link').all_inner_texts()]
            def overflow():return page.evaluate('document.documentElement.scrollWidth>document.documentElement.clientWidth')
            def shot(name,w):
                assert not overflow(),f'horizontal overflow {name}@{w}';assert page.evaluate('getComputedStyle(document.body).backgroundColor')!='rgba(0, 0, 0, 0)'
                page.screenshot(path=str(out/f'{name}-{w}.png'))
            # --- live ---
            MOCKS.clear();MOCKS.update(LIVE)
            for w in [360,390,430]:
                page.set_viewport_size({'width':w,'height':844})
                page.goto(base+'/projects');expect(page.get_by_test_id('source-banner')).to_have_attribute('data-source','live');expect(page.get_by_text('알파 프로젝트').first).to_be_visible();expect(page.get_by_text('미분류').first).to_be_visible();assert nav()==['▤\n프로젝트','◉\nAI 팀','◆\nPM 브리핑'] or len(nav())==3;shot('live-projects',w)
                assert page.get_by_role('button',name='+ 새 프로젝트').count()==0 and page.get_by_role('switch').count()==0
                for pid in route_variants('label:알파 프로젝트'):
                    page.goto(base+'/projects/'+pid);expect(page.get_by_role('heading',name='알파 프로젝트',exact=True).first).to_be_visible();expect(page.get_by_text('남은 업무 · 1')).to_be_visible();expect(page.get_by_text('완료 업무 · 1')).to_be_visible()
                for pid in route_variants('milestone:7'):
                    page.goto(base+'/projects/'+pid);expect(page.get_by_text('실제 목표 문장').first).to_be_visible();expect(page.get_by_text('남은 업무 · 1')).to_be_visible()
                shot('live-project-detail',w)
                for pid in route_variants('label:알파 프로젝트'):
                    page.goto(base+'/projects/'+pid+'/tasks/2');expect(page.get_by_text('상태 라벨만 확인됨').first).to_be_visible();assert page.get_by_text('업무 완료').count()==0
                page.goto(base+'/projects/'+quote('milestone:7',safe='')+'/tasks/4');expect(page.get_by_text('#4 마일스톤 업무').first).to_be_visible();shot('live-task',w)
                # real link click-through from the list uses the app's own hrefs
                page.goto(base+'/projects');page.get_by_role('link',name='알파 프로젝트').first.click();expect(page.get_by_text('남은 업무 · 1')).to_be_visible();page.get_by_role('link',name='#2').first.click();expect(page.get_by_text('상태 라벨만 확인됨').first).to_be_visible()
                page.goto(base+'/projects/'+quote('label:없는 프로젝트',safe=''));expect(page.get_by_text('프로젝트를 찾지 못했습니다.')).to_be_visible()
                page.goto(base+'/agents');expect(page.get_by_test_id('agent-gpt-state')).to_have_text('항상 ON');expect(page.get_by_test_id('agent-sonnet-state')).to_have_text('OFF');expect(page.get_by_text('사용량 · 확인 불가').first).to_be_visible();assert page.get_by_role('switch').count()==0;assert page.get_by_text('실행 중').count()==0;shot('live-agents',w)
                page.goto(base+'/briefing');expect(page.get_by_role('heading',name='PM 브리핑')).to_be_visible();shot('live-briefing',w)
            # --- unconnected ---
            MOCKS.clear();MOCKS.update(UNCONF)
            page.goto(base+'/projects');expect(page.get_by_test_id('source-banner')).to_have_attribute('data-source','unconnected');expect(page.get_by_test_id('unconnected')).to_be_visible();assert page.get_by_text('알파 프로젝트').count()==0;shot('unconnected-projects',390)
            page.goto(base+'/briefing');expect(page.get_by_test_id('unconnected')).to_be_visible();page.goto(base+'/agents');expect(page.get_by_test_id('agent-gpt-state')).to_have_text('항상 ON');expect(page.get_by_test_id('agent-codex-state')).to_have_text('ON/OFF 확인 불가')
            # --- partial ---
            MOCKS.clear();MOCKS.update(PARTIAL)
            page.goto(base+'/projects');expect(page.get_by_test_id('source-banner')).to_have_attribute('data-source','partial');expect(page.get_by_text('알파 프로젝트').first).to_be_visible();shot('partial-projects',390)
            page.goto(base+'/projects/'+quote('label:알파 프로젝트',safe=''));expect(page.get_by_text('완료 업무 · 0')).to_be_visible();expect(page.get_by_text('남은 업무 · 2')).to_be_visible()  # #119: evidence lost → closed nondeploy is unknown, never complete
            # --- closed nondeploy with an OPEN linked PR, then evidence lost ---
            OPENPR=dict(number=9,url='https://github.com/example/repo/pull/9',title='PR for #1',state='open',draft=False,base='main',head='x',headSha='a'*40,linkedBy=['body'],commits=dict(count=1,truncated=False),reviews=[],comments=[],revisions=0,detail='loaded')
            for label,evid in [('open-pr',(200,dict(mode='live',report=dict(EVID,issues=[dict(i,pulls=[OPENPR]) if i['number']==1 else i for i in EVID['issues']])))),('truncated',(200,dict(mode='live',report=dict(EVID,limits=dict(EVID['limits'],pullsTruncated=True))))),('no-matching-issue',(200,dict(mode='live',report=dict(EVID,issues=[i for i in EVID['issues'] if i['number']!=1])))),('error',(500,{}))]:
                MOCKS.clear();MOCKS.update(LIVE);MOCKS['/api/evidence']=evid
                page.goto(base+'/projects/'+quote('label:알파 프로젝트',safe=''));expect(page.get_by_text('완료 업무 · 0')).to_be_visible(timeout=15000),label
            page.goto(base+'/projects');page.get_by_text('계정 · 로그인됨',exact=False).click();page.get_by_role('button',name='로그아웃',exact=True).click();expect(page.get_by_label('아이디',exact=True)).to_be_visible()
            assert not errors,errors;assert not external,external;assert not mutations,mutations;browser.close();print('PASS: live/unconnected/partial, 360/390/430, read-only, no mutations')
    finally:
        proxy.shutdown();proxy.server_close();proc.terminate()
        try:proc.wait(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
        log.close()
