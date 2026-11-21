// Scrubber Duckies push notifications.
// Runs whenever a house changes, and sends a notification to the other people in that house.
// Deploy: see SETUP.md, "Push notifications".

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { notificationsFor } = require('./notify');

admin.initializeApp();

// Must match your Firestore database's location (Firebase console → Firestore Database → the location
// shown at the top of the Data tab, or in Project settings). europe-west2 = London.
// If yours says eur3 use 'europe-west1'; if it says nam5 use 'us-central1'.
const REGION = 'europe-west2';
setGlobalOptions({ region: REGION, maxInstances: 3, memory: '256MiB' });

const APP_URL = 'https://willparslow.github.io/scrubber-duckies/';

exports.houseNotifications = onDocumentUpdated('homes/{hid}', async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  const notes = notificationsFor(before, after);
  if (!notes.length) return;

  const hid = event.params.hid;
  const db = admin.firestore();
  const subs = await db.collection('pushTokens').where('homeId', '==', hid).get();
  if (subs.empty) return;
  const memberEmails = new Set(after.memberEmails || []);

  const sends = [];
  for (const doc of subs.docs) {
    const sub = doc.data();
    if (!memberEmails.has(sub.email)) continue;          // left the house
    const prefs = { jobs: true, oneoffs: true, levels: true, ducks: true, ...(sub.prefs || {}) };
    for (const n of notes) {
      if (!prefs[n.type]) continue;
      if (n.to === 'others' && n.exceptKey === sub.key) continue;
      for (const token of sub.tokens || []) sends.push({ doc, token, n });
    }
  }
  if (!sends.length) return;

  const results = await Promise.allSettled(sends.map(({ token, n }) => admin.messaging().send({
    token,
    // Data only: the app's service worker shows it (title, body, which notification to replace)
    data: { title: n.title, body: n.body, tag: n.tag, url: APP_URL },
    webpush: { headers: { Urgency: 'high', TTL: String(6 * 60 * 60) } },
  })));

  // Forget phones that have uninstalled the app or turned notifications off
  const dead = new Map();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') return;
    const code = r.reason?.errorInfo?.code || r.reason?.code || '';
    if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token') || code.includes('invalid-argument')) {
      const { doc, token } = sends[i];
      if (!dead.has(doc.id)) dead.set(doc.id, { ref: doc.ref, tokens: [] });
      dead.get(doc.id).tokens.push(token);
    } else {
      logger.warn('Push failed', code || r.reason?.message);
    }
  });
  await Promise.all([...dead.values()].map(({ ref, tokens }) => ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(...tokens) })));
  logger.info(`House ${hid}: ${notes.length} notification(s), ${sends.length} send(s), ${results.filter((r) => r.status === 'fulfilled').length} delivered`);
});
