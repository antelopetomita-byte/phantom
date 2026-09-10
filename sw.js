/* Ghosts service worker — push notifications + numeric app badge (no fetch caching, to avoid stale content) */
self.addEventListener('install', e=>{ self.skipWaiting(); });
self.addEventListener('activate', e=>{ e.waitUntil(self.clients.claim()); });

/* tiny persistent counter so the badge survives SW restarts */
function badgeDB(){ return new Promise((res,rej)=>{ const r=indexedDB.open('ghosts_badge',1); r.onupgradeneeded=()=>{ r.result.createObjectStore('kv'); }; r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function getCount(){ try{ const db=await badgeDB(); return await new Promise(res=>{ const t=db.transaction('kv','readonly').objectStore('kv').get('c'); t.onsuccess=()=>res(t.result||0); t.onerror=()=>res(0); }); }catch(e){ return 0; } }
async function setCount(n){ try{ const db=await badgeDB(); await new Promise(res=>{ const t=db.transaction('kv','readwrite').objectStore('kv').put(n,'c'); t.onsuccess=()=>res(); t.onerror=()=>res(); }); }catch(e){} }
async function applyBadge(n){ try{ if(n>0){ if(self.navigator&&self.navigator.setAppBadge) await self.navigator.setAppBadge(n); } else { if(self.navigator&&self.navigator.clearAppBadge) await self.navigator.clearAppBadge(); } }catch(e){} }

self.addEventListener('push', (event)=>{
  let data={title:'Ghosts', body:'新しいメッセージ'};
  try{ if(event.data) data=Object.assign(data, event.data.json()); }catch(e){}
  const opts={
    body:data.body, icon:'icon-192.png', badge:'icon-192.png',
    tag:data.tag||'ghosts-msg', renotify:true, data:{url:'./'}
  };
  event.waitUntil((async()=>{
    await self.registration.showNotification(data.title, opts);
    // increment unread counter and show it as a number on the app icon
    const n=(await getCount())+1;
    await setCount(n);
    await applyBadge(n);
  })());
});

/* page tells SW the real unread count (sync) or to clear it */
self.addEventListener('message', (event)=>{
  const d=event.data||{};
  if(d.type==='syncCount'){ event.waitUntil((async()=>{ const n=Math.max(0, d.n|0); await setCount(n); await applyBadge(n); })()); }
  else if(d.type==='clearBadge'){ event.waitUntil((async()=>{ await setCount(0); await applyBadge(0); })()); }
});

self.addEventListener('notificationclick', (event)=>{
  event.notification.close();
  event.waitUntil((async()=>{
    await setCount(0); await applyBadge(0); // opening the app clears the badge
    const all=await self.clients.matchAll({type:'window', includeUncontrolled:true});
    for(const c of all){ if('focus' in c) return c.focus(); }
    if(self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
