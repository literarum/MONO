const CACHE='mono-shell-v36';
// Static modules only; credential requests remain excluded with every /api/ URL.
const APP_FILES=['/','/index.html','/styles.css','/ui/tokens.css','/ui/controls.css','/ui/scroll-area.css','/ui/motion.css','/ui/refine.css','/ui/system.css','/ui/index.js','/ui/select.js','/ui/select-model.js','/ui/layers.js','/ui/scroll-area.js','/ui/scroll-model.js','/ui/drawer.js','/ui/drawer-model.js','/app.js','/db.js','/legacy-db.js','/library-client.js','/library-migration.js','/backup-core.js','/manifest.webmanifest','/icon.svg','/icon-maskable.svg','/icon-192.png','/icon-512.png','/icon-maskable-512.png'];
APP_FILES.push('/credentials.js','/capture-client.js','/native-capture.js','/native-sources.js','/onboarding-model.js','/onboarding.js','/help.js','/help-model.js','/media-interlock.js');
APP_FILES.push('/audio-review.js','/ui/player.js','/transcription-selection.js');
APP_FILES.push('/browser-microphone.js','/microphone-pcm.js','/microphone-worklet.js');
APP_FILES.push('/capture-diagnostic.js','/preflight.js','/ui/glass.css');
APP_FILES.push('/window-guard.js','/prefs.js','/favicon.ico','/favicon-32.png');APP_FILES.push('/studio-extras.js','/speakers.js','/autopilot.js','/intelligence.js','/diagnostics.js','/safety-track.js','/waveform.js');
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(APP_FILES.map(url=>new Request(url,{cache:'reload'})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  const usable=(response,pathname=url.pathname)=>{
    if(!response?.ok)return false;
    const type=response.headers.get('Content-Type')||'';
    if(pathname.endsWith('.css'))return /^text\/css(?:;|$)/i.test(type);
    if(/\.m?js$/.test(pathname))return /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(type);
    if(pathname==='/'||pathname.endsWith('.html'))return /^text\/html(?:;|$)/i.test(type);
    return true;
  };
  const fallback=async()=>{
    const cached=await caches.match(event.request);if(usable(cached))return cached;
    if(event.request.mode==='navigate'||event.request.destination==='document'){
      const shell=await caches.match('/index.html');if(usable(shell,'/index.html'))return shell;
    }
    return Response.error();
  };
  event.respondWith(fetch(event.request,{cache:'no-cache'}).then(response=>{
    if(!usable(response))return fallback();
    if(APP_FILES.includes(url.pathname)){const copy=response.clone();void caches.open(CACHE).then(cache=>cache.put(event.request,copy)).catch(()=>console.warn('MONO: shell cache update unavailable'))}
    return response
  }).catch(fallback))
});
