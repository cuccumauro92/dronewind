// DroneWind Push Notification Worker
// Runs on Cloudflare Workers with KV storage + Cron triggers
// Checks wind conditions every 3h and sends push notifications

// Mirror of FS array in index.html — keep in sync when adding spots
const SPOTS = [
  {id:1,name:"Casa — Via M. Buonarroti 2A",lat:39.5647,lng:8.9011},
  {id:2,name:"Villa Comunale",lat:39.5640,lng:8.8960},
  {id:3,name:"Castello Eleonora d'Arborea",lat:39.5633,lng:8.8979},
  {id:4,name:"Piazza San Pietro",lat:39.5612,lng:8.8998},
  {id:5,name:"Chiesa San Lorenzo",lat:39.5628,lng:8.8965},
  {id:6,name:"Chiesa Sacro Cuore — Strovina",lat:39.5238,lng:8.8483},
  {id:7,name:"Chiesa Sant'Antiogu nou",lat:39.5745,lng:8.9094},
  {id:8,name:"Campo sportivo",lat:39.5670,lng:8.8850},
  {id:9,name:"Periferia nord — campi",lat:39.5720,lng:8.8900},
  {id:10,name:"Zona artigianale est",lat:39.5650,lng:8.9080},
  {id:11,name:"Castello Monreale — Sardara",lat:39.5950,lng:8.7932},
  {id:12,name:"Nuraghe Ortu Comidu",lat:39.5897,lng:8.8444},
  {id:13,name:"Campagna SP4 — Terme Sardara",lat:39.6139,lng:8.7858},
  {id:14,name:"Nuraghe Arrubiu — Sardara",lat:39.6174,lng:8.7628},
  {id:15,name:"Campi SS131 — Mogoro/Sardara",lat:39.6400,lng:8.7700},
  {id:16,name:"Chiesa Santu Antiogu Becciu",lat:39.6069,lng:8.8890},
  {id:17,name:"Nuraghe Genna Maria — Collinas",lat:39.6344,lng:8.8544},
  {id:18,name:"Nuraghe Cuccuru de su Casu",lat:39.5968,lng:8.8740},
  {id:19,name:"Parco della Giara — Tuili",lat:39.7319,lng:8.9743},
  {id:20,name:"Su Nuraxi — Barumini",lat:39.7059,lng:8.9907},
];

const MV = 35; // max wind threshold (km/h)

export default {
  // HTTP handler — manages subscriptions
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    // POST /subscribe — save push subscription
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const body = await request.json();
      const sub = body.subscription;
      const spots = body.spots || []; // favorite spot IDs
      if (!sub || !sub.endpoint) return new Response('{"error":"missing subscription"}', { status: 400, headers });
      const key = 'sub:' + btoa(sub.endpoint).slice(0, 64);
      await env.SUBS.put(key, JSON.stringify({ sub, spots, ts: Date.now() }));
      return new Response('{"ok":true}', { headers });
    }

    // DELETE /subscribe — remove subscription
    if (url.pathname === '/subscribe' && request.method === 'DELETE') {
      const body = await request.json();
      if (!body.endpoint) return new Response('{"error":"missing endpoint"}', { status: 400, headers });
      const key = 'sub:' + btoa(body.endpoint).slice(0, 64);
      await env.SUBS.delete(key);
      return new Response('{"ok":true}', { headers });
    }

    // GET /vapid — return public VAPID key
    if (url.pathname === '/vapid') {
      return new Response(JSON.stringify({ publicKey: env.VAPID_PUBLIC }), { headers });
    }

    // GET /check — manually trigger a wind check (for testing)
    if (url.pathname === '/check') {
      const result = await checkAndNotify(env);
      return new Response(JSON.stringify(result), { headers });
    }

    // GET /digest?mode=morning|evening — manually trigger digest (for testing)
    if (url.pathname === '/digest') {
      const mode = url.searchParams.get('mode') === 'evening' ? 'evening' : 'morning';
      const result = await sendDigest(env, mode);
      return new Response(JSON.stringify(result), { headers });
    }

    return new Response('{"service":"dronewind-push"}', { headers });
  },

  // Cron handler — runs at 6,7,9,12,15,18,20,21 UTC
  // Routes by Rome local hour: 8 → morning digest, 22 → evening digest, others → change alerts
  async scheduled(event, env, ctx) {
    const romeHour = parseInt(new Date().toLocaleString('en-GB', {
      timeZone: 'Europe/Rome', hour: '2-digit', hour12: false
    }));
    if (romeHour === 8)  return ctx.waitUntil(sendDigest(env, 'morning'));
    if (romeHour === 22) return ctx.waitUntil(sendDigest(env, 'evening'));
    ctx.waitUntil(checkAndNotify(env));
  }
};

// ── DIGEST: weekly summary at 08:00 (today→Sunday) and 22:00 (tomorrow→Sunday) ──
async function sendDigest(env, mode) {
  // Compute Rome-local "today" date
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = fmt.formatToParts(new Date());
  const ymd = parts.filter(p=>p.type!=='literal').reduce((a,p)=>(a[p.type]=p.value,a),{});
  const todayStr = `${ymd.year}-${ymd.month}-${ymd.day}`;

  // Day of week in Rome (0=Sun..6=Sat)
  const romeDow = new Date(todayStr+'T12:00:00+01:00').getUTCDay(); // approx, good enough
  // Days to Sunday inclusive (today=Sun → 1 day, today=Mon → 7 days, etc.)
  const daysToSundayInclusive = romeDow === 0 ? 1 : (7 - romeDow + 1);

  const startOffset = mode === 'evening' ? 1 : 0;
  let nDays = daysToSundayInclusive - startOffset;
  if (nDays < 1) nDays = 1; // safety
  if (nDays > 7) nDays = 7; // Open-Meteo free limit

  // Aggregate spots: hardcoded SPOTS + any spots passed by subscribers (custom)
  const allSpotsMap = new Map();
  SPOTS.forEach(s => allSpotsMap.set(`${s.lat.toFixed(4)},${s.lng.toFixed(4)}`, s));

  const subList = await env.SUBS.list({ prefix: 'sub:' });
  const subscribers = [];
  for (const key of subList.keys) {
    try {
      const data = JSON.parse(await env.SUBS.get(key.name));
      if (!data || !data.sub) continue;
      subscribers.push(data);
      // include custom spots from subscribers
      if (Array.isArray(data.spots)) {
        data.spots.forEach(sp => {
          if (sp && typeof sp === 'object' && sp.lat && sp.lng && sp.name) {
            const k = `${sp.lat.toFixed(4)},${sp.lng.toFixed(4)}`;
            if (!allSpotsMap.has(k)) allSpotsMap.set(k, { id: sp.id, name: sp.name, lat: sp.lat, lng: sp.lng });
          }
        });
      }
    } catch {}
  }

  if (subscribers.length === 0) return { sent: 0, reason: 'no subscribers' };

  const allSpots = Array.from(allSpotsMap.values());

  // Fetch forecast and compute 2h windows for each spot
  // bestPerDay[dayStr] = { window, spot } — best window across all spots that day
  const bestPerDay = {};

  await Promise.all(allSpots.map(async spot => {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lng}&hourly=windspeed_10m,windspeed_80m,windgusts_10m&windspeed_unit=kmh&timezone=Europe%2FRome&forecast_days=${nDays}`;
      const r = await fetch(u);
      if (!r.ok) return;
      const d = await r.json();
      const hours = d.hourly.time.map((t, i) => {
        const v10 = d.hourly.windspeed_10m[i] || 0;
        const v80 = d.hourly.windspeed_80m[i] || v10 * 1.2;
        const v50 = Math.round(v10 + (v80 - v10) * (40 / 70));
        const g = Math.round(d.hourly.windgusts_10m[i] || 0);
        return { day: t.split('T')[0], hr: parseInt(t.split('T')[1]), v50, g };
      });
      const byDay = {};
      hours.forEach(h => { (byDay[h.day] = byDay[h.day] || []).push(h); });
      Object.entries(byDay).forEach(([day, arr]) => {
        arr.sort((a,b)=>a.hr-b.hr);
        for (let i = 0; i < arr.length - 1; i++) {
          const h0 = arr[i], h1 = arr[i+1];
          if (h1.hr !== h0.hr + 1) continue;
          const w0 = Math.max(h0.v50, h0.g), w1 = Math.max(h1.v50, h1.g);
          if (w0 > MV || w1 > MV) continue;
          const maxWorst = Math.max(w0, w1);
          const ratingOrder = maxWorst <= 15 ? 0 : maxWorst <= 30 ? 1 : 2;
          const win = { day, startHr: h0.hr, endHr: h1.hr + 1, maxWorst, ratingOrder, spotName: spot.name };
          const cur = bestPerDay[day];
          if (!cur || win.ratingOrder < cur.ratingOrder || (win.ratingOrder === cur.ratingOrder && win.maxWorst < cur.maxWorst)) {
            bestPerDay[day] = win;
          }
        }
      });
    } catch {}
  }));

  // Build message body
  const dayLabels = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
  const pad = n => String(n).padStart(2, '0');
  const ratingTxt = o => o === 0 ? 'OTTIMO' : o === 1 ? 'BUONO' : 'ATTENZIONE';

  const lines = [];
  for (let i = 0; i < nDays; i++) {
    const dt = new Date(todayStr + 'T12:00:00+01:00');
    dt.setUTCDate(dt.getUTCDate() + startOffset + i);
    const dStr = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}`;
    let label;
    if (dStr === todayStr) label = 'Oggi';
    else if (i === 0 && mode === 'evening') label = 'Domani';
    else label = dayLabels[dt.getUTCDay()];

    const w = bestPerDay[dStr];
    if (w) {
      lines.push(`${label} ${pad(w.startHr)}–${pad(w.endHr)} ${ratingTxt(w.ratingOrder)} @ ${w.spotName}`);
    } else {
      lines.push(`${label} — nessuna finestra`);
    }
  }

  const title = mode === 'morning'
    ? '🌅 Mattino — Settimana di volo'
    : '🌙 Sera — Settimana di volo';

  const notif = {
    title,
    body: lines.join('\n'),
    tag: `digest-${mode}-${todayStr}`
  };

  // Send to all subscribers
  let sent = 0, failed = 0;
  for (const data of subscribers) {
    try {
      const ok = await sendPush(data.sub, notif, env);
      if (ok) sent++; else failed++;
    } catch { failed++; }
  }

  return { mode, sent, failed, days: nDays, title, body: notif.body };
}

async function checkAndNotify(env) {
  // 1. Fetch wind for all spots
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ds = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate());
  const hr = now.getHours();

  const windData = {};
  await Promise.all(SPOTS.map(async spot => {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lng}&hourly=windspeed_10m,windspeed_80m,windgusts_10m&windspeed_unit=kmh&timezone=Europe%2FRome&start_date=${ds}&end_date=${ds}`;
      const r = await fetch(u);
      const d = await r.json();
      let i = d.hourly.time.findIndex(t => parseInt(t.split('T')[1]) === hr);
      if (i < 0) i = 0;
      const v10 = d.hourly.windspeed_10m[i] || 0;
      const v80 = d.hourly.windspeed_80m[i] || v10 * 1.2;
      const v50 = Math.round(v10 + (v80 - v10) * (40/70));
      const g = Math.round(d.hourly.windgusts_10m[i] || 0);
      windData[spot.id] = { v50, g, status: getStatus(v50, g) };
    } catch {}
  }));

  // 2. Load previous state
  let prevState = {};
  try {
    const prev = await env.SUBS.get('_prevState');
    if (prev) prevState = JSON.parse(prev);
  } catch {}

  // 3. Detect changes (nogo/warn -> go/ottimo)
  const improved = [];
  for (const spot of SPOTS) {
    const cur = windData[spot.id];
    const prev = prevState[spot.id];
    if (!cur) continue;
    if (prev && (prev === 'nogo' || prev === 'warn') && (cur.status === 'go' || cur.status === 'ottimo')) {
      improved.push({ ...spot, ...cur });
    }
  }

  // 4. Save current state
  const newState = {};
  for (const spot of SPOTS) {
    if (windData[spot.id]) newState[spot.id] = windData[spot.id].status;
  }
  await env.SUBS.put('_prevState', JSON.stringify(newState));

  // 5. Build daily summary (at 6 AM) or change alert
  const is6am = hr >= 5 && hr <= 7;
  let notifications = [];

  if (is6am) {
    // Daily summary
    const flyable = SPOTS.filter(s => windData[s.id] && (windData[s.id].status === 'ottimo' || windData[s.id].status === 'go'));
    if (flyable.length > 0) {
      const body = flyable.map(s => {
        const d = windData[s.id];
        const lbl = d.status === 'ottimo' ? 'OTTIMO' : 'BUONO';
        return `${s.name}: ${lbl} (${d.v50}km/h, raff ${d.g})`;
      }).join('\n');
      notifications.push({
        title: `DroneWind — ${flyable.length} spot volabili oggi`,
        body,
        tag: 'daily-' + ds
      });
    }
  }

  if (improved.length > 0) {
    const body = improved.map(s => {
      const lbl = s.status === 'ottimo' ? 'OTTIMO' : 'BUONO';
      return `${s.name}: ${lbl} (${s.v50}km/h)`;
    }).join('\n');
    notifications.push({
      title: `Condizioni migliorate!`,
      body,
      tag: 'change-' + Date.now()
    });
  }

  if (notifications.length === 0) return { sent: 0, reason: 'no changes' };

  // 6. Send to all subscribers
  const list = await env.SUBS.list({ prefix: 'sub:' });
  let sent = 0, failed = 0;

  for (const key of list.keys) {
    try {
      const data = JSON.parse(await env.SUBS.get(key.name));
      if (!data || !data.sub) continue;
      for (const notif of notifications) {
        const ok = await sendPush(data.sub, notif, env);
        if (ok) sent++; else failed++;
      }
    } catch { failed++; }
  }

  return { sent, failed, notifications: notifications.length, improved: improved.length };
}

function getStatus(v50, g) {
  const w = Math.max(v50, g);
  if (w > MV) return 'nogo';
  if (w > 30) return 'warn';
  if (w > 15) return 'go';
  return 'ottimo';
}

// Web Push implementation using Web Crypto API (no npm dependencies)
async function sendPush(subscription, payload, env) {
  try {
    const body = JSON.stringify(payload);
    const vapidHeaders = await createVapidAuth(
      new URL(subscription.endpoint).origin,
      env.VAPID_SUBJECT,
      env.VAPID_PUBLIC,
      env.VAPID_PRIVATE
    );

    const encrypted = await encryptPayload(subscription, body);

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        ...vapidHeaders,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': encrypted.byteLength.toString(),
        'TTL': '86400',
      },
      body: encrypted,
    });

    if (res.status === 410 || res.status === 404) {
      // Subscription expired, clean up
      return false;
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function createVapidAuth(audience, subject, publicKey, privateKey) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: audience, exp: now + 86400, sub: subject };

  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const claimsB64 = btoa(JSON.stringify(claims)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const unsigned = headerB64 + '.' + claimsB64;

  const privBytes = base64urlToBytes(privateKey);
  const pubBytes = base64urlToBytes(publicKey);

  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToBase64url(pubBytes.slice(1, 33)),
    y: bytesToBase64url(pubBytes.slice(33, 65)),
    d: bytesToBase64url(privBytes),
  };

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  const sigB64 = bytesToBase64url(new Uint8Array(sig));

  const token = unsigned + '.' + sigB64;
  return {
    Authorization: 'vapid t=' + token + ', k=' + publicKey,
  };
}

async function encryptPayload(subscription, plaintext) {
  const clientPublicKey = base64urlToBytes(subscription.keys.p256dh);
  const authSecret = base64urlToBytes(subscription.keys.auth);
  const payload = new TextEncoder().encode(plaintext);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublicKey = await crypto.subtle.exportKey('raw', serverKeys.publicKey);

  const clientKey = await crypto.subtle.importKey('raw', clientPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeys.privateKey, 256);

  const authInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), clientPublicKey, new Uint8Array(serverPublicKey));
  const ikm = await hkdf(authSecret, new Uint8Array(sharedSecret), authInfo, 32);
  const keyInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const contentKey = await hkdf(salt, ikm, keyInfo, 16);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const padded = concatBytes(payload, new Uint8Array([2])); // padding delimiter
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded);

  // aes128gcm header: salt(16) + rs(4) + keyIdLen(1) + keyId(65)
  const rs = new ArrayBuffer(4);
  new DataView(rs).setUint32(0, 4096);
  const header = concatBytes(salt, new Uint8Array(rs), new Uint8Array([65]), new Uint8Array(serverPublicKey));
  return concatBytes(header, new Uint8Array(encrypted));
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
  const key2 = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const infoWithCounter = concatBytes(info, new Uint8Array([1]));
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', key2, infoWithCounter));
  return okm.slice(0, length);
}

function concatBytes(...arrays) {
  const len = arrays.reduce((a, b) => a + b.byteLength, 0);
  const result = new Uint8Array(len);
  let offset = 0;
  for (const arr of arrays) { result.set(new Uint8Array(arr.buffer || arr), offset); offset += arr.byteLength; }
  return result;
}

function base64urlToBytes(b64) {
  const str = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(str + '=='.slice(0, (4 - str.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bytesToBase64url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
