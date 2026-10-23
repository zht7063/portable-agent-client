import { readFileSync, writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import type { ServerSession } from './proxy/server-session';

/*
 * Dev-only login smoke (PA_SMOKE=1 PA_SMOKE_LOGIN=1, against a LOCAL test server with a throwaway account).
 * Logs in through the upstream sign-in page, then asserts the renderer never saw the session cookie, the real
 * access token or the full API key: localStorage/sessionStorage/document.cookie/DOM and every proxied response body.
 * Inputs (never logged): PA_SMOKE_USER, PA_SMOKE_PASS_FILE, PA_SMOKE_SECRET_FILE (full test key to look for).
 */
export type SmokeExtra = (js: <T>(code: string) => Promise<T>, secret: string) => Promise<{ result: unknown; ok: boolean; haystack: string }>;
export function runLoginSmoke(w: BrowserWindow, srv: ServerSession, finish: (r: unknown, code: number) => void, extra?: SmokeExtra) {
  const user = process.env.PA_SMOKE_USER ?? '';
  const pass = readFileSync(process.env.PA_SMOKE_PASS_FILE ?? '', 'utf8').trim();
  const secrets = new Set<string>();
  if (process.env.PA_SMOKE_SECRET_FILE) secrets.add(readFileSync(process.env.PA_SMOKE_SECRET_FILE, 'utf8').trim());

  // Audit hooks: remember every real access token issued and every response body handed to the renderer.
  const issue = srv.vault.issue.bind(srv.vault);
  let issued = 0;
  srv.vault.issue = (real: string) => { issued++; secrets.add(real); return issue(real); };
  const bodies: string[] = [];
  const handle = srv.handle.bind(srv);
  srv.handle = async (req) => {
    const res = await handle(req);
    if (res.headers.has('set-cookie')) bodies.push('SET-COOKIE-LEAK');
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('event-stream') || !res.body) return res;
    const text = await res.text();
    bodies.push(text);
    return new Response(text, { status: res.status, headers: res.headers });
  };

  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }, 1), 90000);
  const js = <T>(code: string) => w.webContents.executeJavaScript(code) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (code: string, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js<boolean>(code)) return true; await sleep(250); }
    return false;
  };

  w.webContents.once('did-finish-load', async () => {
    try {
      await w.loadURL(w.webContents.getURL().replace(/\/[^/]*$/, '/sign-in'));
      if (!(await waitFor(`!!document.querySelector('input[name=username]')`))) throw new Error('sign-in form not found');
      await js(`document.querySelector('input[name=username]').focus()`);
      w.webContents.insertText(user);
      await js(`document.querySelector('input[name=password]').focus()`);
      w.webContents.insertText(pass);
      await js(`document.querySelector('button[type=submit]').click()`);
      const loggedIn = await waitFor(`!location.pathname.startsWith('/sign-in')`, 25000);
      if (!loggedIn) throw new Error('login did not leave /sign-in: ' + (await js<string>(`document.body.innerText.slice(0,300)`)));
      // Visit the API key list (keys masked by the proxy) and the dashboard.
      await js(`history.pushState({}, '', '/keys'); dispatchEvent(new PopStateEvent('popstate'))`);
      await waitFor(`document.body.innerText.includes('**********')`, 20000);
      await sleep(1500);
      const probe = await js<Record<string, unknown>>(`(async () => {
        // Plain fetches carry no Authorization: proves no ambient credential (cookie) exists in the renderer.
        const self = await fetch('/api/user/self'); const tokens = await fetch('/api/token/?p=1&size=10');
        return {
          path: location.pathname,
          cookie: document.cookie,
          local: JSON.stringify(Object.fromEntries(Object.entries(localStorage))),
          session: JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))),
          dom: document.documentElement.outerHTML,
          selfStatus: self.status, selfSetCookie: self.headers.get('set-cookie'),
          tokens: await tokens.text(),
        };
      })()`);
      const testKey = process.env.PA_SMOKE_SECRET_FILE ? readFileSync(process.env.PA_SMOKE_SECRET_FILE, 'utf8').trim() : '';
      const ex = extra ? await extra(js, testKey) : null;
      if (ex) {
        // Re-read renderer-visible state after the M4 actions (IPC results + DOM + storage).
        const after = await js<string>(`document.documentElement.outerHTML + JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)) + document.cookie`);
        probe.dom = String(probe.dom) + after;
      }
      if (process.env.PA_SMOKE_SCREENSHOT) writeFileSync(process.env.PA_SMOKE_SCREENSHOT, (await w.webContents.capturePage()).toPNG());
      const cookieValues = srv.jar.all().map((c) => c.value).filter((v) => v.length >= 8);
      cookieValues.forEach((v) => secrets.add(v));
      const haystacks: Record<string, string> = {
        cookie: String(probe.cookie), localStorage: String(probe.local), sessionStorage: String(probe.session),
        dom: String(probe.dom), tokensResponse: String(probe.tokens), proxiedBodies: bodies.join('\n'), ...(ex ? { ipcResponses: ex.haystack } : {}),
      };
      const leaks = Object.entries(haystacks).filter(([, h]) => [...secrets].some((s) => s && h.includes(s))).map(([k]) => k);
      const r = {
        loggedIn, path: probe.path, selfStatusWithoutHandle: probe.selfStatus, documentCookie: probe.cookie, selfSetCookie: probe.selfSetCookie,
        mainJarCookies: srv.jar.all().map((c) => `${c.name}@${c.path}`), accessTokensIssued: issued,
        responsesAudited: bodies.length, setCookieLeak: bodies.includes('SET-COOKIE-LEAK'),
        maskedKeyShown: bodies.some((b) => b.includes('**********')) && String(probe.dom).includes('****'), leaks,
        ...(ex ? { m4: ex.result } : {}),
        serverCheck: srv.serverCheck && { verdict: srv.serverCheck.verdict, version: srv.serverCheck.serverVersion, allowLogin: srv.serverCheck.allowLogin },
      };
      clearTimeout(timer);
      const ok = loggedIn && probe.selfStatus === 401 && probe.cookie === '' && !probe.selfSetCookie && !r.setCookieLeak
        && leaks.length === 0 && r.mainJarCookies.length > 0 && r.maskedKeyShown && r.accessTokensIssued > 0 && (!ex || ex.ok);
      finish(r, ok ? 0 : 1);
    } catch (e) { clearTimeout(timer); finish({ ok: false, reason: String(e) }, 1); }
  });
}
