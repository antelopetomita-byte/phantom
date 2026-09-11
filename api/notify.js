const webpush = require('web-push');
const admin = require('firebase-admin');

// --- init Firebase Admin once (credentials from Vercel env vars) ---
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FB_PROJECT_ID,
      clientEmail: process.env.FB_CLIENT_EMAIL,
      privateKey: (process.env.FB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@ghosts.app',
  process.env.VAPID_PUBLIC,
  process.env.VAPID_PRIVATE
);

const ALLOW_ORIGIN = 'https://antelopetomita-byte.github.io';

// --- very small in-memory rate limit (best-effort; serverless instances are ephemeral) ---
const hits = new Map(); // fromUid -> [timestamps]
function rateLimited(key, max = 30, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }
    const { idToken, toUid, kind } = body || {};
    if (!idToken || !toUid) { res.status(400).json({ error: 'missing idToken or toUid' }); return; }

    // 1) verify the caller's Firebase ID token -> real sender uid (cannot be forged)
    let fromUid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      fromUid = decoded.uid;
    } catch (e) {
      res.status(401).json({ error: 'invalid token' }); return;
    }
    if (fromUid === toUid) { res.status(400).json({ error: 'self' }); return; }

    // 2) rate limit per sender
    if (rateLimited(fromUid)) { res.status(429).json({ error: 'rate limited' }); return; }

    // 3) confirm sender and target are actually connected (DM)
    const pair = [fromUid, toUid].sort();
    const convId = pair[0] + '__' + pair[1];
    const conn = await db.collection('connections').doc(convId).get();
    const members = conn.exists ? (conn.data().members || []) : [];
    if (!conn.exists || !members.includes(fromUid) || !members.includes(toUid)) {
      res.status(403).json({ error: 'not connected' }); return;
    }

    // 4) server reads the recipient's subscription (never exposed to clients)
    const subSnap = await db.collection('pushSubs').doc(toUid).get();
    if (!subSnap.exists) { res.status(200).json({ ok: false, reason: 'no subscription' }); return; }
    let sub;
    try { sub = JSON.parse(subSnap.data().sub); } catch (e) { res.status(200).json({ ok: false, reason: 'bad sub' }); return; }

    // 5) send. body is fixed server-side (no client-controlled content leaks)
    const payload = JSON.stringify({
      title: 'Ghosts',
      body: kind === 'call' ? '📞 着信' : '新しいメッセージ',
    });
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      // clean up dead subscriptions
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await db.collection('pushSubs').doc(toUid).delete().catch(() => {});
      }
      res.status(200).json({ ok: false, reason: 'send failed' }); return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
