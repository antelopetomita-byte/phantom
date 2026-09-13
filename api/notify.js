const webpush = require('web-push');
const admin = require('firebase-admin');

const ALLOW_ORIGIN = 'https://antelopetomita-byte.github.io';

/* --- lazy init so a bad/missing env var returns a readable error instead of crashing the function --- */
let initErr = null;
let db = null;
let ready = false;

function envReport() {
  const k = process.env.FB_PRIVATE_KEY || '';
  return {
    FB_PROJECT_ID: !!process.env.FB_PROJECT_ID,
    FB_CLIENT_EMAIL: !!process.env.FB_CLIENT_EMAIL,
    FB_PRIVATE_KEY: !!k,
    FB_PRIVATE_KEY_len: k.length,
    FB_PRIVATE_KEY_starts_BEGIN: k.trim().startsWith('-----BEGIN'),
    FB_PRIVATE_KEY_has_escaped_newlines: k.includes('\\n'),
    FB_PRIVATE_KEY_has_real_newlines: k.includes('\n'),
    FB_PRIVATE_KEY_wrapped_in_quotes: k.trim().startsWith('"') || k.trim().endsWith('"'),
    VAPID_PUBLIC: !!process.env.VAPID_PUBLIC,
    VAPID_PRIVATE: !!process.env.VAPID_PRIVATE,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT || '(unset)',
  };
}

function ensureInit() {
  if (ready || initErr) return;
  try {
    let key = process.env.FB_PRIVATE_KEY || '';
    key = key.trim();
    if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1); // strip accidental quotes
    key = key.replace(/\\n/g, '\n');                                      // unescape newlines

    if (!process.env.FB_PROJECT_ID) throw new Error('FB_PROJECT_ID is missing');
    if (!process.env.FB_CLIENT_EMAIL) throw new Error('FB_CLIENT_EMAIL is missing');
    if (!key) throw new Error('FB_PRIVATE_KEY is missing');
    if (!key.includes('BEGIN')) throw new Error('FB_PRIVATE_KEY does not look like a PEM key');

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FB_PROJECT_ID,
          clientEmail: process.env.FB_CLIENT_EMAIL,
          privateKey: key,
        }),
      });
    }
    db = admin.firestore();

    if (!process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) throw new Error('VAPID keys missing');
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@phantom.app',
      process.env.VAPID_PUBLIC,
      process.env.VAPID_PRIVATE
    );
    ready = true;
  } catch (e) {
    initErr = (e && e.message) || String(e);
  }
}

const hits = new Map();
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

  ensureInit();

  // GET = health check / diagnostics (no secrets leaked, only booleans + lengths)
  if (req.method === 'GET') {
    if (initErr) { res.status(500).json({ ok: false, initError: initErr, env: envReport() }); return; }
    res.status(200).json({ ok: true, ready: true, env: envReport() });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (initErr) { res.status(500).json({ error: 'server not configured', detail: initErr }); return; }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) {} }
    const { idToken, toUid, kind } = body || {};
    if (!idToken || !toUid) { res.status(400).json({ error: 'missing idToken or toUid' }); return; }

    let fromUid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      fromUid = decoded.uid;
    } catch (e) { res.status(401).json({ error: 'invalid token' }); return; }
    if (fromUid === toUid) { res.status(400).json({ error: 'self' }); return; }

    if (rateLimited(fromUid)) { res.status(429).json({ error: 'rate limited' }); return; }

    const pair = [fromUid, toUid].sort();
    const convId = pair[0] + '__' + pair[1];
    const conn = await db.collection('connections').doc(convId).get();
    const members = conn.exists ? (conn.data().members || []) : [];
    if (!conn.exists || !members.includes(fromUid) || !members.includes(toUid)) {
      res.status(403).json({ error: 'not connected' }); return;
    }

    const subSnap = await db.collection('pushSubs').doc(toUid).get();
    if (!subSnap.exists) { res.status(200).json({ ok: false, reason: 'no subscription' }); return; }
    let sub;
    try { sub = JSON.parse(subSnap.data().sub); } catch (e) { res.status(200).json({ ok: false, reason: 'bad sub' }); return; }

    const payload = JSON.stringify({
      title: 'Phantom',
      body: kind === 'call' ? '着信' : '新しいメッセージ',
    });
    try {
      await webpush.sendNotification(sub, payload);
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await db.collection('pushSubs').doc(toUid).delete().catch(() => {});
      }
      res.status(200).json({ ok: false, reason: 'send failed', code: e && e.statusCode });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
