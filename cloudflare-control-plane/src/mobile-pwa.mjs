import { approvedUserIdentity } from './accounts.mjs';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers }
  });
}

function text(body, type, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': type,
      'cache-control': 'no-store',
      ...headers
    }
  });
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function ensureMobileSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mobile_devices (
      device_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL,
      pairing_code TEXT,
      created_at INTEGER NOT NULL,
      enroll_expires_at INTEGER NOT NULL,
      approved_at INTEGER,
      access_expires_at INTEGER,
      last_seen_at INTEGER,
      revoked_at INTEGER
    )
  `).run();
  const cols=await env.DB.prepare('PRAGMA table_info(mobile_devices)').all();
  if (!(cols.results||[]).some(c=>c.name==='user_id')) await env.DB.prepare('ALTER TABLE mobile_devices ADD COLUMN user_id TEXT').run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_mobile_devices_status_created
    ON mobile_devices(status, created_at DESC)
  `).run();
}

function sixDigitCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, '0');
}

function cleanDeviceId(value) {
  const id = String(value || '').slice(0, 96);
  return /^[a-zA-Z0-9._:-]{8,96}$/.test(id) ? id : '';
}

export async function startMobileEnrollment(request, env, userId = null) {
  await ensureMobileSchema(env);
  const body = await request.json().catch(() => ({}));
  const deviceId = cleanDeviceId(body.device_id);
  const secretHash = String(body.secret_hash || '').toLowerCase();
  const label = String(body.label || 'iPhone/iPad').slice(0, 120);
  if (!deviceId || !/^[a-f0-9]{64}$/.test(secretHash)) {
    return json({ ok: false, error: 'invalid_device_enrollment' }, 400);
  }

  const existing = await env.DB.prepare(
    'SELECT device_id,secret_hash,status,access_expires_at,user_id FROM mobile_devices WHERE device_id=?'
  ).bind(deviceId).first();
  const now = Date.now();
  if (existing && existing.status === 'REVOKED') return json({ok:false,error:'device_revoked_new_device_identity_required'},403);
  if (existing && existing.user_id && existing.user_id !== userId) return json({ok:false,error:'device_bound_to_another_account'},403);
  if (existing && existing.secret_hash !== secretHash) return json({ok:false,error:'device_already_registered'},409);

  if (
    existing &&
    existing.secret_hash === secretHash &&
    existing.status === 'APPROVED' &&
    Number(existing.access_expires_at || 0) > now
  ) {
    return json({ ok: true, status: 'APPROVED', device_id: deviceId });
  }

  const pairingCode = sixDigitCode();
  const enrollExpiresAt = now + 10 * 60 * 1000;
  await env.DB.prepare(`
    INSERT INTO mobile_devices(
      device_id,secret_hash,label,status,pairing_code,created_at,
      enroll_expires_at,approved_at,access_expires_at,last_seen_at,revoked_at,user_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET
      secret_hash=excluded.secret_hash,
      label=excluded.label,
      status='PENDING',
      pairing_code=excluded.pairing_code,
      created_at=excluded.created_at,
      enroll_expires_at=excluded.enroll_expires_at,
      approved_at=NULL,
      access_expires_at=NULL,
      revoked_at=NULL,
      user_id=excluded.user_id
  `).bind(
    deviceId, secretHash, label, 'PENDING', pairingCode, now,
    enrollExpiresAt, null, null, null, null, userId
  ).run();

  return json({
    ok: true,
    status: 'PENDING',
    device_id: deviceId,
    pairing_code: pairingCode,
    expires_at: enrollExpiresAt
  });
}

export async function mobileEnrollmentStatus(request, env) {
  await ensureMobileSchema(env);
  const url = new URL(request.url);
  const deviceId = cleanDeviceId(url.searchParams.get('device_id'));
  if (!deviceId) return json({ ok: false, error: 'invalid_device_id' }, 400);

  const row = await env.DB.prepare(
    'SELECT status,enroll_expires_at,access_expires_at FROM mobile_devices WHERE device_id=?'
  ).bind(deviceId).first();
  if (!row) return json({ ok: false, status: 'NOT_FOUND' }, 404);

  const now = Date.now();
  if (row.status === 'PENDING' && Number(row.enroll_expires_at || 0) <= now) {
    return json({ ok: false, status: 'EXPIRED' }, 410);
  }
  if (row.status === 'APPROVED' && Number(row.access_expires_at || 0) <= now) {
    return json({ ok: false, status: 'EXPIRED' }, 401);
  }
  return json({
    ok: row.status === 'APPROVED',
    status: row.status,
    access_expires_at: row.access_expires_at || null
  });
}

export async function mobileAuthorized(request, env) {
  await ensureMobileSchema(env);
  const auth = request.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (token.length < 32) return null;
  const digest = await sha256Hex(token);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT d.device_id,d.label,d.status,d.access_expires_at,d.user_id
    FROM mobile_devices d
    WHERE d.secret_hash=? AND d.status='APPROVED' AND d.revoked_at IS NULL
      AND (d.user_id IS NULL OR EXISTS(SELECT 1 FROM vone_users u WHERE u.id=d.user_id AND u.status='APPROVED'))
  `).bind(digest).first();
  if (!row || Number(row.access_expires_at || 0) <= now) return null;
  if (row.user_id) {
    const user=await approvedUserIdentity(request,env);
    if (!user || user.id!==row.user_id) return null;
  }
  await env.DB.prepare(
    'UPDATE mobile_devices SET last_seen_at=? WHERE device_id=?'
  ).bind(now, row.device_id).run().catch(() => undefined);
  return row;
}

export async function mobileWhoAmI(request, env) {
  const device = await mobileAuthorized(request, env);
  if (!device) return json({ ok: false, error: 'mobile_auth_required' }, 401);
  return json({
    ok: true,
    device: {
      device_id: device.device_id,
      user_id: device.user_id || null,
      label: device.label,
      access_expires_at: device.access_expires_at
    }
  });
}

export async function mobileDisconnect(request, env) {
  const device = await mobileAuthorized(request, env);
  if (!device) return json({ ok: false, error: 'mobile_auth_required' }, 401);
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE mobile_devices SET status='REVOKED',revoked_at=? WHERE device_id=?"
  ).bind(now, device.device_id).run();
  return json({ ok: true, status: 'REVOKED' });
}

export function mobileManifest() {
  return text(JSON.stringify({
    name: 'V-ONE Mobile',
    short_name: 'V-ONE',
    description: 'V-ONE Master mobile cockpit on Cloudflare.',
    start_url: '/vone-mobile',
    scope: '/vone-mobile/',
    display: 'standalone',
    background_color: '#07070b',
    theme_color: '#07070b',
    icons: [{
      src: '/vone-mobile/icon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any maskable'
    }]
  }), 'application/manifest+json; charset=utf-8');
}

export function mobileIcon() {
  return text(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#8b5cf6"/>
      <stop offset=".55" stop-color="#f97316"/>
      <stop offset="1" stop-color="#a3ff12"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="120" fill="#07070b"/>
  <rect x="128" y="146" width="256" height="220" rx="46" fill="none" stroke="url(#g)" stroke-width="26"/>
  <path d="M174 256h164M256 174v164" stroke="url(#g)" stroke-width="30" stroke-linecap="round"/>
  <circle cx="256" cy="256" r="46" fill="#07070b" stroke="#fff" stroke-width="14"/>
</svg>`, 'image/svg+xml; charset=utf-8', 200, { 'cache-control': 'public, max-age=86400' });
}

export function mobileServiceWorker() {
  return text(`
const CACHE='vone-mobile-r5';
const SHELL=['/vone-mobile','/vone-mobile/manifest.webmanifest','/vone-mobile/icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL))));
self.addEventListener('activate',e=>e.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('vone-mobile-')&&k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const u=new URL(e.request.url);
  if(u.origin!==location.origin) return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});`, 'application/javascript; charset=utf-8', 200, { 'cache-control': 'no-cache' });
}

const MOBILE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07070b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="V-ONE">
<link rel="manifest" href="/vone-mobile/manifest.webmanifest">
<link rel="icon" href="/vone-mobile/icon.svg">
<link rel="apple-touch-icon" href="/vone-mobile/icon.svg">
<title>V-ONE Codex</title>
<style>
:root{color-scheme:dark;--bg:#07070b;--panel:#111119;--panel2:#191923;--txt:#f6f6f8;--muted:#9494a4;--purple:#8b5cf6;--orange:#f97316;--lime:#a3ff12;--line:#292936}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",Inter,system-ui,sans-serif}
body{min-height:100dvh}.app{max-width:760px;margin:auto;min-height:100dvh;padding:calc(env(safe-area-inset-top) + 14px) 14px calc(env(safe-area-inset-bottom) + 18px)}
header{display:flex;align-items:center;justify-content:space-between;padding:10px 4px 16px}.brand{display:flex;gap:12px;align-items:center}.logo{width:42px;height:42px;border:1px solid var(--line);border-radius:14px;display:grid;place-items:center;background:linear-gradient(145deg,#171720,#0b0b10)}.logo b{font-size:18px}.title{font-weight:750;font-size:21px}.sub{font-size:12px;color:var(--muted);margin-top:2px}
.badge{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:7px 10px;color:var(--muted)}.badge.ok{color:var(--lime);border-color:#395315}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:12px;min-height:78px}.k{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.v{font-size:15px;font-weight:700;margin-top:8px}.small{font-size:11px;color:var(--muted);margin-top:4px}
main{background:var(--panel);border:1px solid var(--line);border-radius:22px;overflow:hidden}.chat{height:54dvh;min-height:360px;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:11px}.msg{max-width:88%;padding:11px 13px;border-radius:16px;white-space:pre-wrap;line-height:1.4;font-size:15px}.me{align-self:flex-end;background:#2b1e3d;border:1px solid #47305f}.ai{align-self:flex-start;background:var(--panel2);border:1px solid var(--line)}.meta{font-size:10px;color:var(--muted);margin-top:6px}
.composer{border-top:1px solid var(--line);padding:10px;display:flex;gap:8px;align-items:flex-end}.composer textarea{flex:1;resize:none;min-height:44px;max-height:128px;background:#0c0c12;color:var(--txt);border:1px solid var(--line);border-radius:14px;padding:12px;font:inherit;outline:none}.composer textarea:focus{border-color:#4e3977}.send{height:44px;min-width:58px;border:0;border-radius:14px;background:linear-gradient(135deg,var(--purple),var(--orange));color:#fff;font-weight:800}.send:disabled{opacity:.45}
.footer{display:flex;justify-content:space-between;align-items:center;padding:12px 3px 0;color:var(--muted);font-size:11px}.link{color:#c4b5fd;text-decoration:none;background:none;border:0;padding:0;font:inherit}
.overlay{position:fixed;inset:0;background:rgba(2,2,5,.86);backdrop-filter:blur(12px);display:grid;place-items:center;padding:20px;z-index:20}.overlay.hide{display:none}.pair{width:min(420px,100%);background:#111119;border:1px solid var(--line);border-radius:26px;padding:22px}.pair h2{margin:0 0 8px;font-size:22px}.pair p{color:var(--muted);line-height:1.45}.code{font-size:36px;letter-spacing:.16em;font-weight:850;text-align:center;padding:18px;border-radius:18px;background:#08080d;border:1px solid #343445;margin:18px 0}.wait{color:var(--lime);font-size:13px;text-align:center}
.install{margin-top:10px;padding:10px 12px;border:1px dashed #333341;border-radius:14px;color:var(--muted);font-size:12px;line-height:1.35}
@media(max-width:480px){.grid{grid-template-columns:1fr 1fr}.grid .card:last-child{grid-column:1/-1}.chat{height:55dvh}}
/* V-ONE CODEX / visual layer R1 - no changes to API or identity */
:root{--bg:#070a12;--panel:#0c101b;--panel2:#141a2a;--line:#252e43;--txt:#eef2ff;--muted:#8996b2;--purple:#9172ff;--lime:#79e9c3}
html{background:#070a12}body{background:radial-gradient(ellipse 75% 40% at 85% 0%,rgba(82,64,170,.20),transparent 65%),radial-gradient(ellipse 60% 30% at 0% 65%,rgba(20,105,150,.10),transparent 70%),var(--bg)}
.app{max-width:1180px;padding-left:clamp(12px,3vw,36px);padding-right:clamp(12px,3vw,36px)}
header{padding:15px 5px 22px;border-bottom:1px solid rgba(125,140,190,.12);margin-bottom:18px}
.logo{border:1px solid #5d5b9a;background:linear-gradient(145deg,#232747,#0a0f1d);box-shadow:0 0 28px rgba(128,104,255,.16);color:#d5d0ff}
.title{letter-spacing:-.04em}.sub{color:#8996b2}
.grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}
.card{background:linear-gradient(150deg,rgba(27,33,54,.82),rgba(12,16,27,.94));border-color:#2a344a;border-radius:17px;min-height:90px;box-shadow:inset 0 1px rgba(255,255,255,.035)}
.card .k{letter-spacing:.14em}.badge.ok{border-color:#255a52;color:#83edce;background:rgba(28,121,101,.10)}
main{border-color:#303b54;border-radius:20px;background:linear-gradient(180deg,rgba(14,19,32,.96),rgba(9,13,23,.98));box-shadow:0 18px 70px rgba(0,0,0,.25),0 0 0 1px rgba(127,107,255,.04)}
.chat{height:min(65dvh,740px);min-height:400px;padding:clamp(14px,2.6vw,28px);gap:16px}
.msg{line-height:1.58;border:1px solid rgba(120,137,180,.14);box-shadow:0 6px 20px rgba(0,0,0,.08)}
.composer{padding:14px;border-color:#28334b;background:rgba(10,15,27,.88)}
.composer textarea{background:#0b1222;border-color:#3b4664;border-radius:15px;outline:none}.composer textarea:focus{border-color:#9172ff;box-shadow:0 0 0 3px rgba(145,114,255,.12)}
.send{box-shadow:0 6px 22px rgba(145,114,255,.20)}.footer{padding-top:15px}
.install{border-color:#2b3750;background:rgba(15,22,38,.5)}
@media(max-width:600px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.grid .card:last-child{grid-column:1/-1}.card{min-height:76px}.chat{height:60dvh;min-height:370px}.app{padding-top:calc(env(safe-area-inset-top) + 8px)}}
/* V-ONE Codex workspace shell R2 */
body{background:#070b12}.workspace-rail{position:fixed;inset:0 auto 0 0;width:238px;background:linear-gradient(180deg,#101725,#090e18);border-right:1px solid #273349;z-index:8;display:flex;flex-direction:column;padding:26px 13px 18px;box-shadow:10px 0 50px #0002}.rail-brand{display:flex;align-items:center;gap:12px;padding:5px 10px 30px}.rail-brand strong{font-size:21px;letter-spacing:-.06em}.rail-brand small{display:block;font-size:9px;color:#8193b5;letter-spacing:.17em;margin-top:3px}.rail-glyph{height:39px;width:39px;display:grid;place-items:center;border-radius:12px;border:1px solid #6157a1;background:#1c2342;font-weight:900;font-size:22px;color:#c5b7ff}.rail-label{color:#6e819d;font-size:10px;letter-spacing:.17em;font-weight:700;padding:17px 13px 10px}.rail-action{background:none;border:1px solid transparent;text-align:left;border-radius:11px;color:#aab7cf;font:inherit;font-size:13px;padding:13px;cursor:pointer;margin:2px 0}.rail-action:hover,.rail-action.selected{background:#1d2940;color:#f2f5ff;border-color:#324360}.rail-info{margin:7px 9px;padding:14px 10px;background:#111e2a;border:1px solid #273a49;border-radius:12px;font-size:12px;color:#c5f9e8;line-height:1.8}.rail-info small{color:#8e9eb7}.rail-led{display:inline-block;width:7px;height:7px;background:#70e4bf;border-radius:50%;box-shadow:0 0 12px #70e4bf;margin-right:7px}.rail-bottom{margin-top:auto;padding:18px 10px 0;border-top:1px solid #253047;font-size:10px;letter-spacing:.16em;color:#7e8ba7;display:flex;justify-content:space-between}.workspace-content{margin-left:238px;min-height:100dvh}.workspace-topbar{height:65px;border-bottom:1px solid #263149;display:flex;align-items:center;gap:13px;padding:0 26px;background:#0b101bdc}.workspace-topbar strong{display:block;font-size:13px}.workspace-topbar small{display:block;color:#8495af;font-size:11px;margin-top:4px}.workspace-live{margin-left:auto;color:#82ebc6;border:1px solid #285947;border-radius:20px;padding:6px 10px;font-size:10px;letter-spacing:.1em}.workspace-menu{display:none;border:0;background:none;color:#b8c5e3;font-size:20px;cursor:pointer}.workspace-content .app{max-width:1000px}.workspace-content .app header{padding-top:10px}.workspace-content .grid{grid-template-columns:repeat(3,minmax(0,1fr))}.workspace-content .grid .card:last-child{grid-column:auto}.workspace-content .chat{height:calc(100dvh - 340px);min-height:370px}.workspace-view{display:none}.workspace-view.open{display:block;max-width:1000px;margin:28px auto;padding:24px;border:1px solid #2c3a56;background:#101724;border-radius:18px}.workspace-view h2{font-size:21px;margin:0 0 12px}.workspace-view p{color:#99aac4;line-height:1.6}.workspace-view button{background:#202b44;border:1px solid #425375;border-radius:12px;color:#e4ebff;padding:12px 16px;margin:5px;cursor:pointer}.workspace-content.viewing .app{display:none}
@media(max-width:900px){.workspace-rail{width:220px}.workspace-content{margin-left:220px}.workspace-topbar{padding:0 16px}}
@media(max-width:680px){.workspace-rail{transform:translateX(-102%);transition:transform .25s;width:250px;box-shadow:20px 0 60px #0009}.workspace-rail.open{transform:translateX(0)}.workspace-content{margin-left:0}.workspace-menu{display:block}.workspace-topbar{height:56px}.workspace-topbar small{font-size:10px}.workspace-content .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.workspace-content .grid .card:last-child{grid-column:1/-1}.workspace-content .chat{height:57dvh;min-height:350px}.workspace-view.open{margin:12px;padding:16px}}
/* R4 readability; preserve existing palette */
html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.msg{font-size:16px;line-height:1.6;overflow-wrap:anywhere}
.meta{font-size:12px;color:#b1c1da}
.workspace-topbar strong,.rail-action{font-size:15px}
.workspace-topbar small,.sub,.small,.footer,.install{font-size:13px;line-height:1.5}
.card .k,.rail-label{font-size:12px;color:#afbbd1}
.card .v{font-size:19px}
.composer textarea{font-size:16px;line-height:1.5}
.workspace-view p{color:#b9c7df}
.workspace-view button{font-size:14px;min-height:44px}
.tool-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:18px}
.tool-item{background:#141e30;border:1px solid #34445f;border-radius:14px;padding:14px;min-width:0}
.tool-item strong{display:block;font-size:14px;overflow-wrap:anywhere}
.tool-item p{font-size:12px;margin:7px 0}
.tool-state{display:inline-block;margin-top:9px;font-size:11px;font-weight:700;color:#9be7cb}
.tool-state.hold{color:#f7c28d}
.tool-state.denied{color:#e9a4a9}
.activity-strip{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:9px 14px;background:#121b2c;border-top:1px solid #303d56;color:#c2d3ee;font-size:12px}
.activity-strip[hidden]{display:none}
.activity-dot{height:8px;width:8px;border-radius:50%;background:#79e9c3;box-shadow:0 0 8px #79e9c355}
.activity-strip[data-status="HOLD"] .activity-dot{background:#f7c28d}
@media(max-width:680px){.tool-list{grid-template-columns:1fr}.workspace-content .chat{min-height:320px}}
/* Legibilidade e layout responsivo, mantendo a paleta existente */
html{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body{font-synthesis:none}
.card{min-width:0}
.card .v,.card .sub,.workspace-topbar small{overflow-wrap:anywhere;word-break:break-word}
.card .v{line-height:1.25}
.msg{letter-spacing:.005em}
.meta,.sub,.small,.footer,.install{color:#b8c8e0}
.workspace-view{overflow-wrap:anywhere}
.workspace-view button,.rail-action{touch-action:manipulation}
.composer textarea::placeholder{color:#aabbd3;opacity:1}
@media(max-width:680px){
 .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
 .grid .card:last-child{grid-column:1/-1}
 .workspace-topbar{padding:0 12px}
 .workspace-topbar strong{font-size:14px}
 .chat{height:53dvh;min-height:320px}
 .composer{padding:10px}
 .card .v{font-size:17px}
}
html{-webkit-font-smoothing:auto;text-rendering:geometricPrecision}.msg{font-size:16px;line-height:1.55;text-shadow:none;filter:none}.meta{font-size:12px}@media(max-width:680px){.workspace-content .chat{height:calc(100dvh - 420px);min-height:290px}}</style>
</head>
<body>
<div class="workspace-rail" id="workspaceRail"><div class="rail-brand"><span class="rail-glyph">V</span><div><strong>V·ONE</strong><small>CODEX WORKSPACE</small></div></div><div class="rail-label">WORKSPACE</div><button class="rail-action selected" id="railChat">◈ &nbsp; Agente Master</button><button class="rail-action" id="railHistory">◷ &nbsp; Histórico</button><button class="rail-action" id="railActivity">Atividades</button><button class="rail-action" id="railTools">⌘ &nbsp; Ferramentas</button><div class="rail-label">EXECUÇÃO</div><div class="rail-info"><span class="rail-led"></span> Control Plane Cloud<br><small>Cloudflare · Zero Bill</small></div><div class="rail-bottom"><a href="/vone-access" style="color:#b9c6e5;text-decoration:none">Login / Cadastro</a> · <a href="/vone-admin" style="color:#b9c6e5;text-decoration:none">Administração</a> <span>R3</span></div></div>
<div class="workspace-content" id="workspaceContent"><div class="workspace-topbar"><button id="railToggle" class="workspace-menu" aria-label="Abrir menu">☰</button><div><strong>Master / Conversa</strong><small>Ambiente de execução conectado à nuvem</small></div><span class="workspace-live">● LIVE</span></div><div class="workspace-view" id="workspaceView"></div><div class="app">
<header><div class="brand"><div class="logo"><b>V1</b></div><div><div class="title">V-ONE Codex</div><div class="sub">AI Workspace · Cloudflare 24/7</div></div></div><div id="net" class="badge">CHECK</div></header>
<section class="grid">
<div class="card"><div class="k">Master</div><div id="master" class="v">—</div><div id="phase" class="small">carregando</div></div>
<div class="card"><div class="k">Rotas livres</div><div id="free" class="v">—</div><div id="routes" class="small">—</div></div>
<div class="card"><div class="k">Proteções</div><div class="v">ZERO BILL</div><div class="small">PAID_BLOCKED · HOLD</div></div>
</section>
<main>
<div id="chat" class="chat"></div>
<div id="activityStrip" class="activity-strip" role="status" aria-live="polite" hidden><span class="activity-dot"></span><strong id="activityState">Aguardando</strong><span id="activityDetail"></span></div><div class="composer"><textarea id="prompt" rows="1" placeholder="Fale com o V-ONE Master…"></textarea><button id="send" class="send">Enviar</button></div>
</main>
<div class="footer"><span id="deviceLabel">Dispositivo conectado</span><button id="disconnect" class="link">Desconectar</button></div>
<div class="install">No Safari: Compartilhar → <b>Adicionar à Tela de Início</b>. Depois o V-ONE abre como app próprio.</div>
</div>
</div><div id="pairOverlay" class="overlay hide"><div class="pair"><h2>Conectar este dispositivo</h2><p>O V-ONE criou um pedido seguro de pareamento. A aprovação acontece no Control Plane; nenhuma chave precisa ser digitada aqui.</p><p><a href="/vone-access" style="color:#b8ff94">Entrar ou criar conta</a> · <a href="/vone-admin" style="color:#b8ff94">Painel administrativo</a></p><div id="pairCode" class="code">------</div><div id="pairStatus" class="wait">Aguardando aprovação…</div></div></div>
<script>
const $=id=>document.getElementById(id);
const enc=new TextEncoder();
const rawStore=(()=>{try{const s=window.localStorage;const k='vone.storage.probe';s.setItem(k,'1');s.removeItem(k);return s}catch{return {getItem:()=>null,setItem:()=>{},removeItem:()=>{}}}})();
let accountScope='';
const store={getItem:k=>accountScope?rawStore.getItem('vone.account.'+accountScope+'.'+k):null,setItem:(k,v)=>{if(accountScope)rawStore.setItem('vone.account.'+accountScope+'.'+k,v)},removeItem:k=>{if(accountScope)rawStore.removeItem('vone.account.'+accountScope+'.'+k)}};
const state={deviceId:'',secret:'',ready:false,flushing:false};
async function loadAccountIdentity(){const r=await fetch('/api/accounts/me',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error('account_login_required');const j=await r.json();if(!j.user||j.user.status!=='APPROVED'||!j.user.id)throw Error('approved_account_required');accountScope=String(j.user.id);state.deviceId=store.getItem('vone.device')||'';state.secret=store.getItem('vone.secret')||'';if(!state.secret){const oldSecret=rawStore.getItem('vone.secret');const oldId=rawStore.getItem('vone.device');if(oldSecret&&oldId){try{const m=await fetch('/api/mobile/me',{headers:{authorization:'Bearer '+oldSecret},credentials:'same-origin',cache:'no-store'});const data=await m.json();if(m.ok&&data.ok&&String(data.device?.user_id||'')===accountScope){state.secret=oldSecret;state.deviceId=oldId;store.setItem('vone.secret',oldSecret);store.setItem('vone.device',oldId)}}catch{}}}return j.user}
function b64url(bytes){let s='';bytes.forEach(b=>s+=String.fromCharCode(b));return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
async function hashHex(s){const d=await crypto.subtle.digest('SHA-256',enc.encode(s));return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('')}
function makeIdentity(){if(!state.deviceId)state.deviceId='ios-'+crypto.randomUUID();if(!state.secret){const b=new Uint8Array(32);crypto.getRandomValues(b);state.secret=b64url(b)}store.setItem('vone.device',state.deviceId);store.setItem('vone.secret',state.secret)}
function auth(){return {'content-type':'application/json','authorization':'Bearer '+state.secret}}
function setActivity(status,detail=''){const bar=$('activityStrip');bar.hidden=!status;bar.dataset.status=status||'';$('activityState').textContent=status||'';$('activityDetail').textContent=detail||''}
function addMsg(role,text,meta=''){const el=document.createElement('div');el.className='msg '+(role==='me'?'me':'ai');const body=document.createElement('div');body.textContent=text;el.appendChild(body);if(meta){const m=document.createElement('div');m.className='meta';m.textContent=meta;el.appendChild(m)}$('chat').appendChild(el);$('chat').scrollTop=$('chat').scrollHeight;saveHistory()}
function saveHistory(){const items=[...document.querySelectorAll('.msg')].slice(-30).map(x=>({role:x.classList.contains('me')?'me':'ai',text:x.firstChild.textContent,meta:x.querySelector('.meta')?.textContent||''}));store.setItem('vone.history',JSON.stringify(items))}
function loadHistory(){try{const items=JSON.parse(store.getItem('vone.history')||'[]');for(const x of items)addMsg(x.role,x.text,x.meta)}catch{}if(!$('chat').children.length)addMsg('ai','V-ONE Mobile pronto. Assim que este dispositivo estiver pareado, posso executar pelo Master na nuvem.')}
function getQueue(){try{return JSON.parse(store.getItem('vone.queue')||'[]')}catch{return[]}}
function saveQueue(q){store.setItem('vone.queue',JSON.stringify(q.slice(-20)))}
function enqueuePrompt(p){const q=getQueue();q.push({id:crypto.randomUUID(),prompt:p,ts:Date.now()});saveQueue(q)}
async function syncCloudHistory(){if(!state.ready)return;try{const r=await fetch('/api/mobile/history',{headers:auth(),cache:'no-store'});if(!r.ok)return;const j=await r.json();if(!j.ok||!Array.isArray(j.messages)||!j.messages.length)return;document.getElementById('chat').replaceChildren();for(const m of j.messages)addMsg(m.role==='user'?'me':'ai',m.content,'Cloudflare D1');}catch{}}
async function pollHubJob(id){for(let i=0;i<50;i++){if(!state.ready)return;try{const r=await fetch('/api/mobile/hub/job?job_id='+encodeURIComponent(id),{headers:auth(),cache:'no-store'});const j=await r.json();if(r.ok&&j.status==='PASS'){const jobs=JSON.parse(store.getItem('vone.pending.jobs')||'[]');store.setItem('vone.pending.jobs',JSON.stringify(jobs.filter(x=>x!==id)));addMsg('ai',j.text,'V-ONE Hub · '+(j.model||'Worker'));setActivity('PASS','Resultado verificado');return}if(j.status==='FAIL'||(!r.ok&&r.status!==202)){addMsg('ai','Falha: '+(j.error||r.status),'FAIL');setActivity('FAIL',j.error||'Falha');return}setActivity('EXECUTANDO','Worker '+(j.worker_id||'aguardando')+' · '+(i+1)*3+'s')}catch{}await new Promise(r=>setTimeout(r,3000))}setActivity('HOLD','Retome em Atividades')}
async function sendPromptToCloud(p){const r=await fetch('/api/mobile/chat',{method:'POST',headers:auth(),body:JSON.stringify({prompt:p,profile:'AUTO',max_tokens:900})});const j=await r.json().catch(()=>({}));return {r,j}}
async function flushQueue(){if(state.flushing||!state.ready||!navigator.onLine)return;state.flushing=true;try{let q=getQueue();while(q.length&&navigator.onLine){const item=q[0];let out;try{out=await sendPromptToCloud(item.prompt)}catch{break}if(!out.r.ok||!out.j.ok)break;q.shift();saveQueue(q);addMsg('ai',out.j.text||'Concluído.',(out.j.profile||'AUTO')+' · '+(out.j.model||out.j.route||'V-ONE')+' · reenviado')}}finally{state.flushing=false}}
async function who(){if(!state.secret)return false;const r=await fetch('/api/mobile/me',{headers:{authorization:'Bearer '+state.secret}});if(!r.ok)return false;const j=await r.json();state.ready=!!j.ok;if(state.ready)await syncCloudHistory();return state.ready}
async function enroll(){makeIdentity();$('pairOverlay').classList.remove('hide');const account=await fetch('/api/accounts/me',{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null);if(!account?.user||account.user.status!=='APPROVED'){$('pairStatus').textContent='Entre com sua conta aprovada para usar este dispositivo. Se ja foi pareado, nao precisa de novo codigo.';return;}const secretHash=await hashHex(state.secret);const r=await fetch('/api/mobile/enroll/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({device_id:state.deviceId,secret_hash:secretHash,label:navigator.platform||'iPhone/iPad'})});const j=await r.json();if(!r.ok){$('pairStatus').textContent=j.error==='approved_account_login_required'?'Entre com uma conta aprovada antes de conectar este dispositivo. Use o link acima.':'Falha no pareamento: '+(j.error||r.status);return}if(j.status==='APPROVED'){state.ready=true;$('pairOverlay').classList.add('hide');return} $('pairCode').textContent=j.pairing_code||'------';pollPair()}
async function pollPair(){for(let i=0;i<150&&!state.ready;i++){await new Promise(r=>setTimeout(r,2000));const r=await fetch('/api/mobile/enroll/status?device_id='+encodeURIComponent(state.deviceId));const j=await r.json().catch(()=>({}));if(j.status==='APPROVED'){state.ready=true;$('pairStatus').textContent='Aprovado';setTimeout(()=>$('pairOverlay').classList.add('hide'),500);return}if(j.status==='EXPIRED'){$('pairStatus').textContent='Pareamento expirado. Reabra o app.';return}}}
async function refreshStatus(){try{const r=await fetch('/api/mobile/status',{cache:'no-store'});const j=await r.json();$('net').textContent=r.ok?'ONLINE':'HOLD';$('net').className='badge '+(r.ok?'ok':'');const m=j.mission||j.continuity?.mission||null;$('master').textContent=m?.status||j.service||'ONLINE';$('phase').textContent=m?.phase||j.architecture||'Cloudflare';const states=j.capacity?.states||j.capacity?.summary?.states||{};$('free').textContent=String((states.FREE_AVAILABLE||0)+(states.FREE_QUEUE||0));$('routes').textContent=(j.capacity?.routes||j.capacity?.summary?.routes||'—')+' rotas totais'}catch{$('net').textContent='OFFLINE';$('net').className='badge'}}
async function send(){const p=$('prompt').value.trim();if(!p||!state.ready)return;$('prompt').value='';addMsg('me',p);if(p==='/status'||p==='/capacidade'||p==='/ferramentas'){try{const name=p==='/status'?'vone_status':p==='/capacidade'?'vone_capacity_plan':'vone_tool_catalog';const r=await fetch('/api/mobile/tool',{method:'POST',headers:auth(),body:JSON.stringify({name})});const j=await r.json();addMsg('ai',JSON.stringify(j,null,2),'Ferramenta '+name)}catch(e){addMsg('ai','Ferramenta indisponivel: '+String(e))}return;}if(!navigator.onLine){enqueuePrompt(p);addMsg('ai','Sem internet agora. Sua mensagem ficou salva neste iPhone e será enviada automaticamente quando a conexão voltar.','fila local');return}$('send').disabled=true;setActivity('EXECUTANDO','Despacho ao Master; aguardando recibo');addMsg('ai','Processando no V-ONE…','em execução');const pending=$('chat').lastElementChild;let out;try{out=await sendPromptToCloud(p)}catch{pending.remove();enqueuePrompt(p);addMsg('ai','Conexão caiu. Mensagem salva localmente para reenvio automático.','fila local');$('send').disabled=false;return}pending.remove();setActivity(out.r.ok&&out.j.ok?'PASS':'HOLD',out.j.task_id?'Tarefa '+out.j.task_id:(out.j.error||out.j.backend||out.j.route||''));if(out.j.error==='VONE_HUB_EXECUTION_PENDING'&&out.j.job_id){
 const id=out.j.job_id;
 const jobs=JSON.parse(store.getItem('vone.pending.jobs')||'[]');
 store.setItem('vone.pending.jobs',JSON.stringify([...new Set([...jobs,id])]));
 addMsg('ai','Solicitacao recebida pelo V-ONE. Consulte Atividades para acompanhar.','EXECUTANDO · '+id);
 $('send').disabled=false;pollHubJob(id);return;
}
if(!out.r.ok||!out.j.ok){addMsg('ai','HOLD: '+(out.j.error||'Falha no V-ONE')+(out.j.task_id?'\\nTask: '+out.j.task_id:'')+(out.j.evidence?'\\nEvidencia: '+JSON.stringify(out.j.evidence,null,2):''));$('send').disabled=false;return}addMsg('ai',out.j.text||'Concluído.',(out.j.profile||'AUTO')+' · '+(out.j.model||out.j.route||'V-ONE'));$('send').disabled=false;$('prompt').focus()}
$('send').addEventListener('click',send);$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
$('disconnect').addEventListener('click',async()=>{if(state.secret)await fetch('/api/mobile/disconnect',{method:'POST',headers:auth()}).catch(()=>{});store.removeItem('vone.secret');store.removeItem('vone.device');store.removeItem('vone.history');store.removeItem('vone.queue');location.reload()});
window.addEventListener('online',()=>{refreshStatus();flushQueue()});window.addEventListener('offline',()=>{$('net').textContent='OFFLINE';$('net').className='badge'});
(async()=>{refreshStatus();if('serviceWorker'in navigator)navigator.serviceWorker.register('/vone-mobile/sw.js').catch(()=>{});try{await loadAccountIdentity()}catch{$('pairOverlay').classList.remove('hide');$('pairStatus').textContent='Entre com sua conta aprovada antes de conectar este dispositivo.';return}loadHistory();makeIdentity();if(await who()){state.ready=true;flushQueue();for(const id of JSON.parse(store.getItem('vone.pending.jobs')||'[]'))pollHubJob(id)}else await enroll()})();
window.addEventListener('focus',async()=>{if(!accountScope)return;try{const r=await fetch('/api/accounts/me',{credentials:'same-origin',cache:'no-store'});const j=await r.json();if(!r.ok||String(j.user?.id||'')!==accountScope){state.ready=false;location.reload()}}catch{}});
// Workspace navigation is presentation-only; chat authentication and API remain unchanged.
(function(){const rail=document.getElementById('workspaceRail'),content=document.getElementById('workspaceContent'),view=document.getElementById('workspaceView');const close=()=>rail.classList.remove('open');const select=(id)=>{document.querySelectorAll('.rail-action').forEach(x=>x.classList.toggle('selected',x.id===id));close()};document.getElementById('railToggle').addEventListener('click',()=>rail.classList.toggle('open'));document.getElementById('railChat').addEventListener('click',()=>{select('railChat');view.classList.remove('open');content.classList.remove('viewing')});document.getElementById('railHistory').addEventListener('click',()=>{select('railHistory');content.classList.add('viewing');view.classList.add('open');view.replaceChildren();const h=document.createElement('h2');h.textContent='Histórico de execução';const p=document.createElement('p');p.textContent='Mensagens persistidas na Cloudflare D1 para este dispositivo autorizado. A sincronização entre contas e dispositivos distintos ainda não está habilitada.';const b=document.createElement('button');b.textContent='Voltar à conversa';b.onclick=()=>document.getElementById('railChat').click();view.append(h,p,b)});document.getElementById('railActivity').addEventListener('click',()=>{select('railActivity');content.classList.add('viewing');view.classList.add('open');view.replaceChildren();const h=document.createElement('h2');h.textContent='Atividades';view.append(h);const jobs=JSON.parse(store.getItem('vone.pending.jobs')||'[]');if(!jobs.length){const p=document.createElement('p');p.textContent='Nenhuma tarefa pendente';view.append(p)}for(const id of jobs){const b=document.createElement('button');b.textContent='Retomar '+id.slice(0,12);b.onclick=()=>{document.getElementById('railChat').click();pollHubJob(id)};view.append(b)}});document.getElementById('railTools').addEventListener('click',()=>{select('railTools');content.classList.add('viewing');view.classList.add('open');view.replaceChildren();const h=document.createElement('h2');h.textContent='Ferramentas do Master';const p=document.createElement('p');p.textContent='Consultas verificáveis com autorização do dispositivo. Nenhuma rota paga ou execução privilegiada é ativada por estes atalhos.';view.append(h,p);for(const [label,cmd] of [['Estado do Master','/status'],['Planejamento de capacidade','/capacidade']]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>{document.getElementById('railChat').click();document.getElementById('prompt').value=cmd;document.getElementById('send').click()};view.appendChild(b)}const catalog=document.createElement('button');catalog.textContent='Consultar catalogo completo';catalog.onclick=async()=>{catalog.disabled=true;try{const r=await fetch('/api/mobile/tool',{method:'POST',headers:auth(),body:JSON.stringify({name:'vone_tool_catalog'})});const data=await r.json();if(!r.ok)throw Error(data.error||'HTTP '+r.status);const grid=document.createElement('div');grid.className='tool-list';for(const t of data.tools||[]){const item=document.createElement('article');item.className='tool-item';const name=document.createElement('strong');name.textContent=t.name;const description=document.createElement('p');description.textContent=t.description||t.mode||'';const status=document.createElement('span');status.className='tool-state'+(/HOLD|VERIFICATION/.test(t.state)?' hold':/DENIED/.test(t.state)?' denied':'');status.textContent=t.state+' / '+(t.permission||'');item.append(name,description,status);grid.append(item)}view.append(grid)}catch(e){const err=document.createElement('p');err.textContent='Catalogo indisponivel: '+e.message;view.append(err)}finally{catalog.disabled=false}};view.append(catalog)})})();
</script>
</body>
</html>`;

export function mobilePage() {
  return text(MOBILE_HTML, 'text/html; charset=utf-8', 200, {
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
  });
}

export async function mobilePendingEnrollments(env) {
  await ensureMobileSchema(env);
  const now = Date.now();
  const rows = await env.DB.prepare(`
    SELECT d.device_id,d.label,d.status,d.pairing_code,d.created_at,d.enroll_expires_at,d.user_id,u.name AS user_name,u.email AS user_email
    FROM mobile_devices d LEFT JOIN vone_users u ON u.id=d.user_id
    WHERE d.status='PENDING' AND d.enroll_expires_at>?
    ORDER BY d.created_at DESC LIMIT 20
  `).bind(now).all();
  return json({ ok: true, pending: rows.results || [] });
}

export async function approveMobileEnrollment(request, env) {
  await ensureMobileSchema(env);
  const body = await request.json().catch(() => ({}));
  const deviceId = cleanDeviceId(body.device_id);
  if (!deviceId) return json({ ok: false, error: 'invalid_device_id' }, 400);
  const now = Date.now();
  const accessExpiresAt = now + 180 * 24 * 60 * 60 * 1000;

  const result = await env.DB.prepare(`
    UPDATE mobile_devices
    SET status='APPROVED',approved_at=?,access_expires_at=?,pairing_code=NULL
    WHERE device_id=? AND status='PENDING' AND enroll_expires_at>?
      AND (user_id IS NULL OR EXISTS(SELECT 1 FROM vone_users WHERE id=mobile_devices.user_id AND status='APPROVED'))
  `).bind(now, accessExpiresAt, deviceId, now).run();
  if (!result.meta?.changes) {
    return json({ ok: false, error: 'pending_enrollment_not_found' }, 404);
  }
  return json({
    ok: true,
    status: 'APPROVED',
    device_id: deviceId,
    access_expires_at: accessExpiresAt
  });
}


