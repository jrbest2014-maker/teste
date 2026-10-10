const J={'content-type':'application/json; charset=utf-8','cache-control':'no-store'};
const json=(o,s=200,h={})=>new Response(JSON.stringify(o),{status:s,headers:{...J,...h}});
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const random=()=>{const b=new Uint8Array(32);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('')};
async function passhash(password,salt){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:100000,hash:'SHA-256'},key,256);return Array.from(new Uint8Array(bits),x=>x.toString(16).padStart(2,'0')).join('')}
async function schema(env){await env.DB.batch([
env.DB.prepare("CREATE TABLE IF NOT EXISTS vone_users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,pass_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,approved_at INTEGER,approved_by TEXT)"),
env.DB.prepare("CREATE TABLE IF NOT EXISTS vone_user_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)"),
env.DB.prepare("CREATE TABLE IF NOT EXISTS vone_user_permissions(user_id TEXT NOT NULL,permission TEXT NOT NULL,enabled INTEGER NOT NULL,updated_at INTEGER NOT NULL,updated_by TEXT NOT NULL,PRIMARY KEY(user_id,permission))"),
 env.DB.prepare("CREATE TABLE IF NOT EXISTS vone_user_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL)")
])}
function cookie(req){const s=req.headers.get('cookie')||'';return s.split(';').map(x=>x.trim()).find(x=>x.startsWith('vone_session='))?.slice(13)||''}
async function session(req,env){const t=cookie(req);if(!/^[a-f0-9]{64}$/.test(t))return null;const row=await env.DB.prepare("SELECT u.id,u.name,u.email,u.role,u.status FROM vone_user_sessions s JOIN vone_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked=0 AND s.expires_at>?").bind(await hash(t),Date.now()).first();return row||null}
const setCookie=t=>'vone_session='+t+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800';
const clearCookie='vone_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
async function audit(env,actor,action,target){await env.DB.prepare('INSERT INTO vone_user_audit(id,actor,action,target,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,target,Date.now()).run()}
export const TEAM_PERMISSIONS=['CODE_REVIEW','CODE_EXECUTE','GITHUB_WRITE','DEPLOY','AGENT_DISPATCH','EVIDENCE_READ','TOOLS_READ'];
export async function userHasPermission(request,env,permission){
 await schema(env);const u=await session(request,env);
 if(!u||u.status!=='APPROVED')return false;
 if(u.role==='OWNER')return true;
 if(!TEAM_PERMISSIONS.includes(permission))return false;
 const override=await env.DB.prepare('SELECT enabled FROM vone_user_permissions WHERE user_id=? AND permission=?').bind(u.id,permission).first();
 return override?Number(override.enabled)===1:u.role==='TEAM';
}
const safe=u=>({id:u.id,name:u.name,email:u.email,role:u.role,status:u.status});
export async function userApi(request,env,ownerTokenAuthorized){
await schema(env);const url=new URL(request.url),p=url.pathname,method=request.method;if(method==='POST'&&request.headers.get('origin')!==url.origin)return json({error:'invalid_origin'},403);const b=method==='POST'?await request.json().catch(()=>({})):{};
if(p==='/api/accounts/bootstrap-status') {const r=await env.DB.prepare("SELECT count(*) AS n FROM vone_users WHERE role='OWNER'").first();return json({ok:true,owner_configured:Number(r?.n||0)>0})}
if(p==='/api/accounts/bootstrap'&&method==='POST'){
 const count=await env.DB.prepare("SELECT count(*) AS n FROM vone_users WHERE role='OWNER'").first();if(Number(count?.n||0)>0)return json({error:'owner_already_configured'},409);
 const presented=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
 const provisioned=String(env.VONE_OWNER_BOOTSTRAP||'');
 const provisionedValid=provisioned.length>=24&&presented.length===provisioned.length&&await hashEqual(await hash(presented),await hash(provisioned));
 if(!provisionedValid && !(await ownerTokenAuthorized(request)))return json({error:'owner_proof_required'},401);
 return create(env,b,'OWNER','APPROVED',null);
}
if(p==='/api/accounts/register'&&method==='POST')return create(env,b,'TEAM','PENDING',null);
if(p==='/api/accounts/login'&&method==='POST'){
 const email=String(b.email||'').trim().toLowerCase();const u=await env.DB.prepare('SELECT * FROM vone_users WHERE email=?').bind(email).first();
 if(!u||!(await hashEqual(await passhash(String(b.password||''),u.salt),u.pass_hash)))return json({error:'invalid_credentials'},401);
 if(u.status!=='APPROVED')return json({error:u.status==='PENDING'?'awaiting_approval':'account_disabled'},403);
 const t=random();await env.DB.prepare('INSERT INTO vone_user_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(await hash(t),u.id,Date.now(),Date.now()+604800000).run();
 return json({ok:true,user:safe(u)},200,{'set-cookie':setCookie(t)});
}
if(p==='/api/accounts/logout'&&method==='POST'){const t=cookie(request);if(t)await env.DB.prepare('UPDATE vone_user_sessions SET revoked=1 WHERE token_hash=?').bind(await hash(t)).run();return json({ok:true},200,{'set-cookie':clearCookie})}
const u=await session(request,env);
if(p==='/api/accounts/me')return u?json({ok:true,user:safe(u)}):json({error:'login_required'},401);
if(!u||u.status!=='APPROVED'||u.role!=='OWNER')return json({error:'owner_required'},403);
if(p==='/api/accounts/users'&&method==='GET'){const rows=await env.DB.prepare("SELECT id,name,email,role,status,created_at,approved_at FROM vone_users ORDER BY created_at DESC LIMIT 100").all();return json({ok:true,users:rows.results||[]})}
if(p==='/api/accounts/permissions'&&method==='GET'){
 const id=String(url.searchParams.get('id')||'');
 const target=await env.DB.prepare('SELECT id,role,status FROM vone_users WHERE id=?').bind(id).first();
 if(!target)return json({error:'user_not_found'},404);
 const rows=await env.DB.prepare('SELECT permission,enabled FROM vone_user_permissions WHERE user_id=?').bind(id).all();
 const overrides=Object.fromEntries((rows.results||[]).map(r=>[r.permission,Boolean(r.enabled)]));
 return json({ok:true,id,role:target.role,status:target.status,permissions:Object.fromEntries(TEAM_PERMISSIONS.map(k=>[k,target.role==='OWNER'?true:(k in overrides?overrides[k]:target.role==='TEAM')]))});
}
if(p==='/api/accounts/permissions'&&method==='POST'){
 const id=String(b.id||''),permission=String(b.permission||''),enabled=b.enabled;
 if(!TEAM_PERMISSIONS.includes(permission)||typeof enabled!=='boolean')return json({error:'invalid_permission'},400);
 const target=await env.DB.prepare('SELECT id,role FROM vone_users WHERE id=?').bind(id).first();
 if(!target||target.role==='OWNER')return json({error:'target_not_allowed'},403);
 await env.DB.prepare('INSERT INTO vone_user_permissions(user_id,permission,enabled,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(user_id,permission) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by').bind(id,permission,enabled?1:0,Date.now(),u.id).run();
 await audit(env,u.id,'PERMISSION_'+permission+'_'+(enabled?'GRANT':'REVOKE'),id);
 return json({ok:true,id,permission,enabled});
}
if(p==='/api/accounts/decision'&&method==='POST'){
 const id=String(b.id||'');const action=String(b.action||'');if(!['APPROVED','REJECTED','DISABLED'].includes(action))return json({error:'invalid_action'},400);
 const target=await env.DB.prepare('SELECT id,role,status FROM vone_users WHERE id=?').bind(id).first();if(!target||target.role==='OWNER')return json({error:'target_not_allowed'},403);
 await env.DB.prepare('UPDATE vone_users SET status=?,approved_at=?,approved_by=? WHERE id=?').bind(action,action==='APPROVED'?Date.now():null,u.id,id).run();
 if(action!=='APPROVED')await env.DB.prepare('UPDATE vone_user_sessions SET revoked=1 WHERE user_id=?').bind(id).run();
 await audit(env,u.id,'USER_'+action,id);return json({ok:true,status:action})
}
return json({error:'not_found'},404);
}
async function hashEqual(a,b){if(a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0}
async function create(env,b,role,status,actor){
 const name=String(b.name||'').trim().slice(0,100),email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
 if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12||password.length>256)return json({error:'invalid_name_email_or_password_min_12'},400);
 const salt=random(),digest=await passhash(password,salt),id=crypto.randomUUID(),now=Date.now();
 try{await env.DB.prepare('INSERT INTO vone_users(id,name,email,pass_hash,salt,role,status,created_at,approved_at,approved_by) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,name,email,digest,salt,role,status,now,status==='APPROVED'?now:null,actor).run()}catch{return json({error:'registration_unavailable_or_email_exists'},409)}
 await audit(env,actor||id,'USER_REGISTER_'+role,id);return json({ok:true,status,role},201)
}
export async function accountsEnforced(env){await schema(env);const r=await env.DB.prepare("SELECT count(*) AS n FROM vone_users WHERE role='OWNER'").first();return Number(r?.n||0)>0}
export async function approvedUserSession(request,env){await schema(env);const u=await session(request,env);return !!u&&u.status==='APPROVED'}
export async function approvedUserIdentity(request,env){await schema(env);const u=await session(request,env);return u?.status==='APPROVED'?safe(u):null}
export async function ownerSession(request,env){await schema(env);const u=await session(request,env);return !!u&&u.role==='OWNER'&&u.status==='APPROVED'}
