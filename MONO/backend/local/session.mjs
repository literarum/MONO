import {randomBytes,timingSafeEqual} from 'node:crypto';
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class LocalSessions{
 constructor(){this.sessions=new Map()}
 bootstrap(req,res){
  const site=req.headers['sec-fetch-site'];if(site&&!['none','same-origin'].includes(site))return null;
  const current=this.get(req);if(current)return current;
  const id=randomBytes(32).toString('hex'),session={csrf:randomBytes(32).toString('hex'),created:Date.now()};
  // Bound memory and revoke the oldest session rather than retaining unlimited tokens.
  for(const [key,s] of this.sessions)if(Date.now()-s.created>86400000)this.sessions.delete(key);
  if(this.sessions.size>=64)this.sessions.delete(this.sessions.keys().next().value);
  this.sessions.set(id,session);res.setHeader('Set-Cookie',`mono_session=${id}; HttpOnly; SameSite=Strict; Path=/`);return session;
 }
 get(req){
  const id=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('mono_session='))?.slice(13);
  const s=this.sessions.get(id);return s&&Date.now()-s.created<86400000?s:null;
 }
 authorize(req){const session=this.get(req);if(!session)return 401;
  if(['GET','HEAD'].includes(req.method))return 0;
  if(!req.headers.origin)return 403;
  // Concurrent first requests (two tabs, or startup racing a reload) each bootstrap a
  // session and the browser keeps only the last cookie, so a page can hold the token of
  // a sibling session. Any live token still proves same-origin read access (cross-site
  // pages cannot read /api/local/session), so accept it instead of failing with 403.
  const token=req.headers['x-mono-csrf'];if(equal(token,session.csrf))return 0;
  for(const s of this.sessions.values())if(Date.now()-s.created<86400000&&equal(token,s.csrf))return 0;
  return 403;
 }
}
