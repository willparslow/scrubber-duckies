import { firebaseConfig, FIREBASE_VERSION } from './firebase-config.js';

/* ------------------------------------------------------------------ *
 *  Scrubber Duckies: house jobs, with a duckie for every one done.
 *  Each house lives in ONE Firestore document (homes/{id}) shared by the
 *  people in it. New houses need a single-use invite code from Will (the
 *  admin); people join an existing house by email invite. Firestore's offline cache keeps it working with no signal;
 *  changes sync when signal returns. Each job done is its own log entry,
 *  so two phones ticking things at the same time never clash.
 *  With no Firebase config it runs in "demo mode" (this phone only).
 * ------------------------------------------------------------------ */

const DEL = Symbol('delete');
const INCK = Symbol('increment');
const INC = (n) => ({ [INCK]: n });
const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');
const sheetEl = document.getElementById('sheet');
const celEl = document.getElementById('cel');

let store = null;   // demo or firebase store
let S = null;       // the house document
let meta = {};      // { fromCache, pending, exists }
let unsub = null;
let me = null;      // { uid, email, key, name, verified }
let saveError = null;
let hid = null;          // the house this person is in
let onboarding = null;   // { screen: 'loading'|'welcome'|'create'|'invited'|'verify'|'error', ... } while not in a house
let isAdminUser = false; // Will: can make invite codes and publish the starter job list
let adminData = null;
let seenLog = null;   // log ids already seen, so the other person's new jobs can pop up a note
let pruned = false;

const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const ui = {
  tab: ls.get('sd.tab') || 'today',
  sheet: null,          // { type: 'undo', eid } | { type: 'jobs' } (Manage jobs) | { type: 'confirm', ... }
  sound: ls.get('sd.sound') !== '0',
};

/* ---------------- the jobs ---------------- */
const FREQS = {
  daily: { label: 'Every day', pts: 1 },
  weekly: { label: 'Weekly', pts: 3 },
  fortnightly: { label: 'Fortnightly', pts: 5 },
  monthly: { label: 'Monthly checks', pts: 10 },
};
/** Duckies a job earns: its own score if one's been set, otherwise the default for how often it happens */
const ONEOFF_PTS = 2;
const defaultPts = (freq) => FREQS[freq]?.pts ?? ONEOFF_PTS;
const ptsOf = (job) => Number(job.pts) > 0 ? Number(job.pts) : defaultPts(job.freq);
const sumPts = (jobs) => jobs.reduce((a, j) => a + ptsOf(j), 0);
const FREQ_SHORT = { daily: 'Daily', weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly' };
const RARE = [
  ['Binjamin', '#7FD1AE', 'bandana'], ['Frosty Quackers', '#9AD7F5', 'goggles'], ['Duvet Duchess', '#C9A7F0', 'crown'],
  ['Pillow Fighter', '#FF9E7A', 'bandana'], ['Fluffy McTowel', '#F7A8C8', 'foam'], ['Captain Suds', '#FFC93C', 'captain'],
  ['Spin Cycle Sid', '#8FB8FF', 'goggles'], ['Sir Splashalot', '#6FD3C9', 'crown'], ['Squeegee Sam', '#B8E986', 'captain'],
  ['Knobbly Nora', '#FFB347', 'foam'],
];
const SPARE_DUCKS = [
  ['Bubbles Bartholomew', '#A0E7E5', 'foam'], ['Mopsy', '#FBC4AB', 'bandana'], ['Dusty Springfield', '#D4C1EC', 'goggles'],
  ['Lady Lather', '#FFDAC1', 'crown'], ['Polly Polish', '#B5EAD7', 'captain'], ['Admiral Scrub', '#9FC5F8', 'captain'],
  ['Hoover Hattie', '#F9C6D3', 'bandana'], ['Grout Expectations', '#C3E88D', 'goggles'],
];
function defaultJobs() {
  const list = {
    daily: ['Dishwasher', 'Laundry: wash', 'Laundry: hang up', 'Laundry: put away', 'Reset kitchen', 'Reset lounge', 'Reset master bedroom', 'Reset boys’ room'],
    weekly: ['Recycling', 'Food bin', 'Clean hallway', 'Clean kitchen', 'Clean lounge', 'Clean bathroom', 'Clean en-suite'],
    fortnightly: ['Black bin', 'Clean master bedroom', 'Clean boys’ room', 'Clean office'],
    monthly: ['Bathroom bins', 'Clean fridge', 'Change master bedding', 'Change boys’ bedding', 'Change towels', 'Clean dishwasher', 'Clean washing machine', 'Clean downstairs bathroom', 'Clean windows', 'Clean doors and handles'],
  };
  const jobs = {};
  let order = 0;
  for (const [freq, names] of Object.entries(list)) {
    names.forEach((name, i) => {
      const id = `${freq[0]}-${slug(name)}`;
      jobs[id] = { name, freq, order: order++ };
      if (name === 'Recycling') jobs[id].bin = true;
      if (name === 'Black bin') jobs[id].bin = true;
      if (freq === 'monthly') { const [dn, color, hat] = RARE[i]; jobs[id].duck = { name: dn, color, hat }; }
    });
  }
  return jobs;
}
/** The first rare duck not already given to a job */
function spareDuck() {
  const used = new Set(Object.values(S.jobs).map((j) => j.duck?.name).filter(Boolean));
  const [name, color, hat] = [...RARE, ...SPARE_DUCKS].find(([n]) => !used.has(n)) || ['Mystery Duck', '#FFC93C', 'captain'];
  return { name, color, hat };
}
function newHouse(person, name, jobs) {
  return {
    name, memberEmails: [person.email], pendingInvites: {},
    jobs: jobs || {}, log: {}, ducks: { [person.key]: 0 }, unlocked: {},
    members: { [person.key]: { name: person.name, email: person.email, joined: Date.now() } },
    createdAt: Date.now(),
  };
}

const LEVELS = [
  { at: 0, name: 'Duckling' }, { at: 25, name: 'Puddle Paddler' }, { at: 75, name: 'Pond Patroller' },
  { at: 150, name: 'Bath Baron' }, { at: 300, name: 'Admiral of Suds' }, { at: 600, name: 'Grand Quackmaster' },
  { at: 1000, name: 'Legend of the Lather' },
];
const levelOf = (n) => LEVELS.filter((l) => n >= l.at).at(-1);
const nextLevel = (n) => LEVELS.find((l) => n < l.at) || null;

const PALETTE = [
  { color: '#2B6CB0', soft: '#E3EEFA', ink: '#1E4E80' },   // first to join: blue
  { color: '#C05621', soft: '#FBEADF', ink: '#8A3A12' },   // second: orange
  { color: '#2F855A', soft: '#E2F4EA', ink: '#22543D' },
  { color: '#6B46C1', soft: '#EEE8FA', ink: '#4C2F94' },
];

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 8);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';
const keyOf = (email) => String(email).toLowerCase().replace(/[^a-z0-9]/g, '_');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => a + Math.random() * (b - a);
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'Someone';
const tick = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function startOfDay(t = Date.now()) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeek(t = Date.now()) { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
/** "Mondays and Thursdays" */
function daysLabel(days) {
  const names = MON_FIRST.filter((d) => days.includes(d)).map((d) => DAY_NAMES[d] + 's');
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '';
}
/** For a job on set days: when the current round started (the evening before its day counts,
 *  so putting the bins out the night before ticks it off) and when it's next due. */
function setDayRound(days) {
  const today = new Date(startOfDay());
  let start = null, next = null;
  for (let k = 0; k <= 7 && start == null; k++) {
    const d = new Date(today); d.setDate(d.getDate() - k);
    const dayAfter = (d.getDay() + 1) % 7;
    if (days.includes(dayAfter)) start = d.getTime();
  }
  for (let k = 0; k <= 7 && next == null; k++) {
    const d = new Date(today); d.setDate(d.getDate() + k);
    if (days.includes(d.getDay())) next = k;
  }
  return { start, next };
}
const nextLabel = (k, days) => k === 0 ? 'today' : k === 1 ? 'tomorrow' : DAY_NAMES[(new Date().getDay() + k) % 7];
const daysAgo = (at) => Math.round((startOfDay() - startOfDay(at)) / 864e5);
const hhmm = (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function when(at) {
  const d = daysAgo(at);
  if (d === 0) return `today ${hhmm(at)}`;
  if (d === 1) return 'yesterday';
  if (d < 7) return new Date(at).toLocaleDateString('en-GB', { weekday: 'long' });
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const duckies = (n) => `+${n} ${n === 1 ? 'duckie' : 'duckies'}`;

function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  t.innerHTML = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function setPath(obj, path, v) {
  const ks = path.split('.'); let o = obj;
  for (let i = 0; i < ks.length - 1; i++) { if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {}; o = o[ks[i]]; }
  const k = ks.at(-1);
  if (v === DEL) delete o[k];
  else if (v && typeof v === 'object' && INCK in v) o[k] = (Number(o[k]) || 0) + v[INCK];
  else o[k] = v;
}
const update = (changes) => store.update(changes);

/* ---------------- the duck ---------------- */
function duck(color = '#FFC93C', hat = 'foam', label = '') {
  const hats = {
    foam: '<g><circle cx="58" cy="26" r="7" fill="#fff" stroke="#9ED8E6" stroke-width="2"/><circle cx="68" cy="18" r="9" fill="#fff" stroke="#9ED8E6" stroke-width="2"/><circle cx="80" cy="18" r="8" fill="#fff" stroke="#9ED8E6" stroke-width="2"/><circle cx="89" cy="26" r="6" fill="#fff" stroke="#9ED8E6" stroke-width="2"/><circle cx="100" cy="12" r="4" fill="#fff" stroke="#9ED8E6" stroke-width="1.5"/><circle cx="106" cy="22" r="2.5" fill="#fff" stroke="#9ED8E6" stroke-width="1.5"/></g>',
    crown: '<g><path d="M58 25 L61 9 L69 19 L75 5 L81 19 L89 9 L91 25 Z" fill="#FFD54A" stroke="#B88A00" stroke-width="2" stroke-linejoin="round"/><circle cx="75" cy="18" r="2.6" fill="#E0457B"/></g>',
    captain: '<g><path d="M55 25 C57 10 92 10 94 25 Z" fill="#1F3B57"/><rect x="50" y="23" width="48" height="6" rx="3" fill="#12263A"/><circle cx="74.5" cy="17" r="3.4" fill="#FFD54A"/></g>',
    bandana: '<g><path d="M52 34 C56 16 92 14 97 32 C82 27 66 28 52 34 Z" fill="#E05A47"/><path d="M53 33 L42 30 L46 38 Z" fill="#E05A47"/><circle cx="70" cy="24" r="1.6" fill="#fff"/><circle cx="82" cy="23" r="1.6" fill="#fff"/></g>',
    goggles: '<g><path d="M52 34 C62 30 92 30 97 36" stroke="#12343B" stroke-width="3" fill="none"/><circle cx="81" cy="38" r="8" fill="#BFE9F5" fill-opacity=".55" stroke="#12343B" stroke-width="2.5"/></g>',
  };
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="duck" viewBox="0 0 120 120" ${a11y}>
    <ellipse cx="58" cy="106" rx="38" ry="5" fill="#12343B" opacity=".10"/>
    <path d="M14 62 L26 70 L22 58 Z" fill="${color}"/>
    <path d="M18 76 C16 58 32 54 46 60 C56 64 66 64 76 60 C92 54 104 64 100 80 C96 96 80 103 58 103 C36 103 20 94 18 76 Z" fill="${color}"/>
    <circle cx="74" cy="42" r="23" fill="${color}"/>
    <path d="M40 76 C48 64 68 66 72 77 C64 88 48 89 40 76 Z" fill="#12343B" opacity=".09"/>
    <path d="M93 44 C105 41 111 47 107 52 C103 57 93 56 90 51 Z" fill="#FF8A3D"/>
    <path d="M92 50 C98 51 104 51 107 52" stroke="#C8621F" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    <circle cx="81" cy="38" r="3.8" fill="#12343B"/><circle cx="82.3" cy="36.7" r="1.3" fill="#fff"/>
    <circle cx="84" cy="50" r="4.2" fill="#FF8FA3" opacity=".55"/>
    ${hats[hat] || ''}</svg>`;
}
const LOCKED = '#C9D3D6';

/* ---------------- stores ----------------
 * Both stores expose the same API. The Firebase one is the real thing; the demo one simulates the
 * same server (several houses, invites, codes) in this browser so every flow can be tried and tested
 * (open tabs with ?demo&as=someone@demo.test).
 * Data model:
 *   homes/{id}        one house: name, memberEmails[], members{key:{name,email,joined}}, pendingInvites{key:{email,at}},
 *                     createdWithCode, plus jobs, log, ducks, unlocked. (Will & Tessa's original house is homes/main.)
 *   invites/{email}   a waiting email invite: homeId, homeName, invitedBy, at
 *   inviteCodes/{c}   admin-made, single-use codes for starting a new house: usedBy, usedByName, usedAt
 *   starter/current   a job list new houses can start with (admin publishes it from their own jobs)
 */
const houseErr = (msg) => Object.assign(new Error(msg), { friendly: msg });
const CODE_WORDS = ['DUCK', 'SUDS', 'MOP', 'SOAP', 'FOAM', 'TOWEL', 'BROOM', 'SPONGE', 'BUBBLE', 'QUACK', 'POND', 'SPLASH'];
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(6));
  return `${CODE_WORDS[r[0] % CODE_WORDS.length]}-${[1, 2, 3, 4, 5].map((i) => chars[r[i] % chars.length]).join('')}`;
}
/** A copy of a house's jobs for others to start from: no one-offs, no set days, nothing personal */
function starterFrom(jobs) {
  const out = {};
  for (const [id, j] of Object.entries(jobs || {})) {
    if (j.freq === 'oneoff') continue;
    const c = { name: j.name, freq: j.freq, order: j.order ?? 0 };
    if (Number(j.pts) > 0) c.pts = Number(j.pts);
    if (j.bin) c.bin = true;
    if (j.duck) c.duck = j.duck;
    out[id] = c;
  }
  return { jobs: out, jobCount: Object.keys(out).length, updatedAt: Date.now() };
}

function demoStore() {
  const params = new URLSearchParams(location.search);
  const email = (params.get('as') || 'will@demo.test').toLowerCase();
  const KEY = 'sd.fakedb2';
  const load = () => { try { return JSON.parse(ls.get(KEY)) || null; } catch { return null; } };
  let db = load() || { homes: {}, invites: {}, codes: {}, starter: null };
  const save = () => { ls.set(KEY, JSON.stringify(db)); emit(); };
  const user = { uid: keyOf(email), email, key: keyOf(email), name: firstName(email.split('@')[0].replace(/^./, (c) => c.toUpperCase())), verified: true };
  const isAdminUser = email.startsWith('will');
  let current = null, cb = null, errCb = null;
  function emit() {
    if (!cb || !current) return;
    const h = db.homes[current];
    if (h && !h.memberEmails.includes(email)) return errCb?.({ code: 'permission-denied' });
    cb(h ? structuredClone(h) : null, { exists: !!h });
  }
  addEventListener('storage', (e) => { if (e.key === KEY) { db = load() || db; emit(); } });
  const tick0 = () => new Promise((r) => setTimeout(r, 0));
  return {
    kind: 'demo',
    me: () => user,
    async findHouse() {
      await tick0();
      return Object.keys(db.homes).find((id) => db.homes[id].memberEmails.includes(email)) || null;
    },
    async getInvite() { await tick0(); return db.invites[email] || null; },
    async starterInfo() { await tick0(); return db.starter ? { jobCount: db.starter.jobCount, updatedAt: db.starter.updatedAt } : null; },
    async createHouse({ name, code, starter }) {
      await tick0();
      if (!isAdminUser) {
        const c = db.codes[code];
        if (!c) throw houseErr('That invite code isn’t right. Check it with Will.');
        if (c.usedBy) throw houseErr('That invite code has already been used.');
      }
      const id = 'h' + rid();
      const jobs = starter ? (db.starter?.jobs || defaultJobs()) : {};
      db.homes[id] = { ...newHouse(user, name, jobs), createdWithCode: code || '' };
      if (code && db.codes[code]) Object.assign(db.codes[code], { usedBy: id, usedByName: name, usedAt: Date.now() });
      save(); return id;
    },
    async joinHouse(inv) {
      await tick0();
      const h = db.homes[inv.homeId];
      if (!h) throw houseErr('That house no longer exists.');
      if (!h.memberEmails.includes(email)) h.memberEmails.push(email);
      h.members[user.key] = { name: user.name, email, joined: Date.now() };
      delete h.pendingInvites[user.key]; delete db.invites[email];
      save(); return inv.homeId;
    },
    async declineInvite() { delete db.invites[email]; save(); },
    async invite(to) {
      await tick0();
      const h = db.homes[current];
      if (h.memberEmails.includes(to)) throw houseErr(`${to} is already in this house.`);
      if (db.invites[to]) throw houseErr(`${to} already has an invite waiting.`);
      db.invites[to] = { homeId: current, homeName: h.name, invitedBy: user.name, at: Date.now() };
      h.pendingInvites[keyOf(to)] = { email: to, at: Date.now() }; save();
    },
    async cancelInvite(to) { delete db.invites[to]; delete db.homes[current].pendingInvites[keyOf(to)]; save(); },
    async removeMember(who) {
      const h = db.homes[current];
      h.memberEmails = h.memberEmails.filter((e) => e !== who); delete h.members[keyOf(who)];
      if (!h.memberEmails.length) delete db.homes[current];
      save();
    },
    async isAdmin() { return isAdminUser; },
    async admin() {
      await tick0();
      return {
        codes: Object.entries(db.codes).map(([code, c]) => ({ code, ...c })).sort((a, b) => b.createdAt - a.createdAt),
        starter: db.starter && { jobCount: db.starter.jobCount, updatedAt: db.starter.updatedAt },
        houses: Object.entries(db.homes).map(([id, h]) => ({ id, name: h.name, count: h.memberEmails.length })),
      };
    },
    async newCode() { const code = makeCode(); db.codes[code] = { usedBy: null, createdAt: Date.now() }; save(); return code; },
    async deleteCode(code) { delete db.codes[code]; save(); },
    async publishStarter(jobs) { db.starter = starterFrom(jobs); save(); },
    open(id) { current = id; },
    close() { current = null; },
    start(fn, onErr) { cb = fn; errCb = onErr; setTimeout(emit, 0); return () => { cb = null; }; },
    update(changes) { const h = db.homes[current]; if (!h) return; for (const [p, v] of Object.entries(changes)) setPath(h, p, v); save(); },
    signOut() { location.search = ''; },
  };
}

async function firebaseStore() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [fbApp, fs, fa] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-firestore.js`),
    import(`${base}/firebase-auth.js`),
  ]);
  const fapp = fbApp.initializeApp(firebaseConfig);
  const db = fs.initializeFirestore(fapp, {
    // Single-tab mode with forced ownership: the open app always owns the offline cache and sends its own
    // changes. (Multi-tab mode can leave writes queued behind a stale, suspended copy of the page on iPhone.)
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentSingleTabManager({ forceOwnership: true }) }),
  });
  const auth = fa.getAuth(fapp);
  let ref = null;
  const H = (id) => fs.doc(db, 'homes', id);
  const D = (...p) => fs.doc(db, ...p);
  const meNow = () => {
    const u = auth.currentUser; if (!u) return null;
    const email = (u.email || '').toLowerCase();
    return { uid: u.uid, email, key: keyOf(email), name: firstName(u.displayName || email.split('@')[0]), verified: u.emailVerified };
  };
  const toFs = (changes) => {
    const out = {};
    for (const [p, v] of Object.entries(changes)) {
      out[p] = v === DEL ? fs.deleteField() : (v && typeof v === 'object' && INCK in v) ? fs.increment(v[INCK]) : v;
    }
    return out;
  };
  return {
    kind: 'firebase',
    me: meNow,
    onAuth: (fn) => fa.onAuthStateChanged(auth, fn),
    signIn: (e, p) => fa.signInWithEmailAndPassword(auth, e, p),
    signUp: async (e, p) => { const c = await fa.createUserWithEmailAndPassword(auth, e, p); await fa.sendEmailVerification(c.user).catch(() => {}); },
    reset: (e) => fa.sendPasswordResetEmail(auth, e),
    sendVerification: () => fa.sendEmailVerification(auth.currentUser),
    async reloadUser() { await auth.currentUser.reload(); await auth.currentUser.getIdToken(true); return meNow(); },
    async google() {
      const provider = new fa.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      // Popup only: the redirect flow breaks on iPhones when the app isn't hosted on Firebase's own domain
      await fa.signInWithPopup(auth, provider);
    },
    signOut: () => fa.signOut(auth),

    /** Which house is this person in? Cached id first (works offline), then ask the server. */
    async findHouse() {
      const me = meNow();
      const cached = ls.get(`sd.hid:${me.uid}`);
      if (cached) return cached;   // the snapshot listener notices if they've since been removed
      try {
        const res = await fs.getDocs(fs.query(fs.collection(db, 'homes'), fs.where('memberEmails', 'array-contains', me.email), fs.limit(1)));
        if (!res.empty) return res.docs[0].id;
      } catch (e) { if (e.code !== 'permission-denied') throw e; }
      // One-off: Will & Tessa's original house from before houses could be shared. Its owners add themselves.
      try {
        const legacy = await fs.getDoc(H('main'));
        if (legacy.exists()) {
          await fs.updateDoc(H('main'), {
            name: legacy.data().name || 'Our house',
            memberEmails: fs.arrayUnion(me.email),
            [`members.${me.key}`]: legacy.data().members?.[me.key] || { name: me.name, email: me.email, joined: Date.now() },
          });
          return 'main';
        }
      } catch { /* not one of its owners */ }
      return null;
    },
    async getInvite() {
      const snap = await fs.getDoc(D('invites', meNow().email));
      return snap.exists() ? snap.data() : null;
    },
    async starterInfo() {
      const s = await fs.getDoc(D('starter', 'current'));
      return s.exists() ? { jobCount: s.data().jobCount, updatedAt: s.data().updatedAt } : null;
    },
    async createHouse({ name, code, starter }) {
      const me = meNow();
      const newRef = fs.doc(fs.collection(db, 'homes'));
      let jobs = {};
      if (starter) {
        const s = await fs.getDoc(D('starter', 'current')).catch(() => null);
        jobs = s?.exists() ? s.data().jobs : defaultJobs();
      }
      const data = { ...newHouse(me, name, jobs), createdWithCode: code || '' };
      if (!code) { await fs.setDoc(newRef, data); return newRef.id; }   // admin only
      const codeRef = D('inviteCodes', code);
      await fs.runTransaction(db, async (tx) => {
        const c = await tx.get(codeRef).catch(() => null);
        if (!c || !c.exists()) throw houseErr('That invite code isn’t right. Check it with Will.');
        if (c.data().usedBy) throw houseErr('That invite code has already been used.');
        tx.set(newRef, data);
        tx.update(codeRef, { usedBy: newRef.id, usedByName: name, usedAt: Date.now() });
      });
      return newRef.id;
    },
    async joinHouse(inv) {
      const me = meNow();
      const batch = fs.writeBatch(db);
      batch.update(H(inv.homeId), {
        memberEmails: fs.arrayUnion(me.email),
        [`members.${me.key}`]: { name: me.name, email: me.email, joined: Date.now() },
        [`pendingInvites.${me.key}`]: fs.deleteField(),
      });
      batch.delete(D('invites', me.email));
      await batch.commit();
      return inv.homeId;
    },
    declineInvite: () => fs.deleteDoc(D('invites', meNow().email)),
    async invite(to) {
      if ((S.memberEmails || []).includes(to)) throw houseErr(`${to} is already in this house.`);
      try {
        await fs.setDoc(D('invites', to), { homeId: ref.id, homeName: S.name || 'our house', invitedBy: meNow().name, at: Date.now() });
      } catch (e) {
        throw houseErr(e.code === 'permission-denied' ? `${to} already has an invite waiting from another house.` : `Couldn’t send the invite: ${e.code || e.message}`);
      }
      await fs.updateDoc(ref, { [`pendingInvites.${keyOf(to)}`]: { email: to, at: Date.now() } });
    },
    async cancelInvite(to) {
      await fs.deleteDoc(D('invites', to)).catch(() => {});
      await fs.updateDoc(ref, { [`pendingInvites.${keyOf(to)}`]: fs.deleteField() });
    },
    async removeMember(who) {
      if (S.memberEmails.length === 1 && S.memberEmails[0] === who) return fs.deleteDoc(ref);   // last one out
      await fs.updateDoc(ref, { memberEmails: fs.arrayRemove(who), [`members.${keyOf(who)}`]: fs.deleteField() });
    },
    async isAdmin() { try { await fs.getDoc(D('admin', 'check')); return true; } catch { return false; } },
    async admin() {
      const [codes, st, homes] = await Promise.all([
        fs.getDocs(fs.collection(db, 'inviteCodes')),
        fs.getDoc(D('starter', 'current')),
        fs.getDocs(fs.collection(db, 'homes')),
      ]);
      return {
        codes: codes.docs.map((d) => ({ code: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
        starter: st.exists() ? { jobCount: st.data().jobCount, updatedAt: st.data().updatedAt } : null,
        houses: homes.docs.map((d) => ({ id: d.id, name: d.data().name || d.id, count: (d.data().memberEmails || []).length })),
      };
    },
    async newCode() { const code = makeCode(); await fs.setDoc(D('inviteCodes', code), { usedBy: null, createdAt: Date.now() }); return code; },
    deleteCode: (code) => fs.deleteDoc(D('inviteCodes', code)),
    publishStarter: (jobs) => fs.setDoc(D('starter', 'current'), starterFrom(jobs)),

    open(id) { ref = H(id); },
    close() { ref = null; },
    start(fn, onErr) {
      return fs.onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
        fn(snap.exists() ? snap.data() : null, { exists: snap.exists(), fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites });
      }, onErr);
    },
    // Not awaited: when offline, Firestore applies the change locally at once and queues it.
    update(changes) {
      if (!ref) return;
      fs.updateDoc(ref, toFs(changes)).then(() => { if (saveError) { saveError = null; render(); } }).catch((e) => {
        console.error('Save failed', e);
        saveError = e.code || e.message; render();
      });
    },
  };
}

/* ---------------- derived data ---------------- */
function normalize(d) {
  d.jobs ||= {}; d.log ||= {}; d.ducks ||= {}; d.unlocked ||= {}; d.members ||= {}; d.memberEmails ||= []; d.pendingInvites ||= {};
  return d;
}
const jobsOf = (freq) => Object.entries(S.jobs).filter(([, j]) => j.freq === freq).map(([id, j]) => ({ id, ...j })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const entries = () => Object.entries(S.log).map(([eid, e]) => ({ eid, ...e })).sort((a, b) => b.at - a.at);
function lastFor(jobId) { let best = null; for (const [eid, e] of Object.entries(S.log)) if (e.job === jobId && (!best || e.at > best.at)) best = { eid, ...e }; return best; }
function memberList() {
  const inHouse = (m) => !S.memberEmails?.length || S.memberEmails.includes(m.email);
  return Object.entries(S.members).map(([key, m]) => ({ key, ...m })).filter(inHouse).sort((a, b) => (a.joined || 0) - (b.joined || 0))
    .map((m, i) => ({ ...m, ...PALETTE[i % PALETTE.length] }));
}
function person(key) {
  const m = memberList().find((x) => x.key === key);
  return m || { key, name: 'Someone', ...PALETTE[3] };
}
const totalDucks = () => Object.values(S.ducks).reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);

/** Where a job stands right now */
function status(job) {
  const last = lastFor(job.id);
  const days = last ? daysAgo(last.at) : null;
  if (job.freq === 'oneoff') return { last, days, done: !!last, doneToday: !!last && last.at >= startOfDay() };
  if (job.freq === 'daily') return { last, days, done: !!last && last.at >= startOfDay() };
  if (job.freq === 'weekly' && job.days?.length) {
    const r = setDayRound(job.days);
    return { last, days, done: !!last && last.at >= r.start, setDays: true, next: r.next };
  }
  if (job.freq === 'weekly') return { last, days, done: !!last && last.at >= startOfWeek() };
  if (job.freq === 'fortnightly') {
    const done = last != null && days < 14;
    return { last, days, done, dueIn: last ? 14 - days : 0, overdue: !done, soon: !last || days >= 10 };
  }
  return { last, days, done: last != null && days === 0 };
}

/* ---------------- sounds ---------------- */
let actx = null;
function squeak(times = 1) {
  if (!ui.sound) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const t = actx.currentTime + i * 0.17;
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(950 + i * 60, t);
      o.frequency.exponentialRampToValueAtTime(1500 + i * 80, t + 0.05);
      o.frequency.exponentialRampToValueAtTime(700, t + 0.14);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.16);
    }
  } catch { /* no sound available */ }
  try { navigator.vibrate?.(times > 1 ? [30, 40, 30, 40, 60] : 25); } catch {}
}

/* ---------------- celebrations ---------------- */
const CONF = ['#FFC93C', '#4FC3F7', '#FF7A59', '#7FD1AE', '#B39DDB', '#FFFFFF', '#F7A8C8'];
const confetti = (n) => Array.from({ length: n }, () => `<i class="confetti" style="left:${rnd(0, 100).toFixed(1)}%;width:${Math.round(rnd(6, 11))}px;height:${Math.round(rnd(10, 16))}px;background:${pick(CONF)};border-radius:${Math.random() > 0.6 ? '50%' : '2px'};animation-duration:${rnd(2.4, 4.2).toFixed(2)}s;animation-delay:${rnd(-3, 1).toFixed(2)}s"></i>`).join('');
const bubbles = (n) => Array.from({ length: n }, () => { const s = Math.round(rnd(10, 30)); return `<i class="bubble" style="left:${rnd(2, 95).toFixed(1)}%;width:${s}px;height:${s}px;animation-delay:${rnd(0, 2.2).toFixed(2)}s"></i>`; }).join('');
const stars = () => Array.from({ length: 40 }, () => `<i class="star" style="left:${rnd(0, 100).toFixed(1)}%;top:${rnd(0, 60).toFixed(1)}%;animation-delay:${rnd(0, 2).toFixed(2)}s"></i>`).join('');
function sparks() {
  const bursts = [[22, 18, '#FFC93C'], [74, 14, '#4FC3F7'], [50, 32, '#FF7A59'], [18, 40, '#B39DDB'], [82, 38, '#7FD1AE']];
  return bursts.map(([x, y, c], bi) => Array.from({ length: 14 }, (_, k) =>
    `<span class="spark-arm" style="left:${x}%;top:${y}%;transform:rotate(${k * (360 / 14)}deg)"><i class="spark" style="background:${c};box-shadow:0 0 8px ${c};animation-delay:${(bi * 0.45).toFixed(2)}s;animation-duration:${1.2 + (bi % 2) * 0.3}s"></i></span>`).join('')).join('');
}
const DAILY_TITLES = ['Quack-tastic!', 'Squeaky clean!', 'Nice one!', 'Bubbly brilliant!', 'Splish splash!', 'Duck-tastic!'];
let celTimer = null;

/** tier: daily | weekly | sweep | fort | monthly */
function celebrate(tier, info) {
  clearTimeout(celTimer);
  if (info.levelUp && tier === 'daily') tier = 'weekly';   // a level-up is always a big moment
  const level = info.levelUp ? `<span class="levelup">Level up! The house is now ${esc(info.levelUp)}</span>` : '';
  const carry = '<span class="carry">Tap anywhere to carry on</span>';
  let html = '';
  if (tier === 'daily') {
    html = `<button class="cel-toast" data-action="close-cel" aria-label="Dismiss">${bubbles(8)}
      <span class="bob cel-duck-s">${duck('#FFC93C', 'foam')}</span>
      <span class="cel-text"><b>${esc(info.title)}</b><small>${esc(info.sub)}</small></span>
      <span class="pts pop">${duckies(info.pts)}</span></button>`;
    squeak(1);
    celTimer = setTimeout(closeCel, 2600);
  } else if (tier === 'weekly' || tier === 'sweep') {
    html = `<button class="cel-full cel-weekly" data-action="close-cel" aria-label="Dismiss">${bubbles(18)}${confetti(tier === 'sweep' ? 40 : 26)}
      <span class="cel-card pop">
        <span class="trio"><span class="bob" style="width:70px;height:70px">${duck('#FFC93C', 'foam')}</span><span class="bob" style="width:92px;height:92px;animation-delay:.25s">${duck('#FFC93C', 'bandana')}</span><span class="bob" style="width:70px;height:70px;animation-delay:.5s">${duck('#FFC93C', 'goggles')}</span></span>
        <b class="cel-title">${esc(info.title)}</b><small>${esc(info.sub)}</small>
        <span class="pts big blue">${duckies(info.pts)}</span>${level}${carry}</span></button>`;
    squeak(2);
  } else if (tier === 'fort') {
    html = `<button class="cel-full cel-gold" data-action="close-cel" aria-label="Dismiss"><i class="rays" aria-hidden="true"></i>${confetti(55)}
      <span class="flip gold-duck">${duck('#F5B800', 'crown')}</span>
      <b class="cel-title pop">${esc(info.title)}</b><small>${esc(info.sub)}</small>
      <span class="pts big gold">${duckies(info.pts)}</span>${level}${carry}</button>`;
    squeak(3);
  } else {
    html = `<button class="cel-full cel-night" data-action="close-cel" aria-label="Dismiss">${stars()}${sparks()}${confetti(45)}
      <span class="kicker">${esc(info.kicker)}</span>
      <span class="cel-card pop"><span class="bob rare-duck">${duck(info.duck.color, info.duck.hat)}</span>
        <b class="cel-title">${esc(info.title)}</b><small>${esc(info.sub)}</small>
        <span class="pts big navy">${duckies(info.pts)}</span>${level}</span>${carry}</button>`;
    squeak(5);
  }
  celEl.innerHTML = html;
}
function closeCel() { clearTimeout(celTimer); celEl.innerHTML = ''; }

/* ---------------- doing a job ---------------- */
function complete(id) {
  const job = { id, ...S.jobs[id] };
  const st = status(job);
  const before = totalDucks();
  let pts = ptsOf(job);
  const overdue = job.freq === 'monthly' && st.days != null && st.days > 45;
  if (overdue) pts *= 2;
  let sweep = false;
  if (job.freq === 'daily') {
    const others = jobsOf('daily').filter((j) => j.id !== id);
    const sweptToday = Object.values(S.log).some((e) => e.sweep && e.at >= startOfDay());
    if (!sweptToday && others.every((j) => status(j).done)) { sweep = true; pts += 5; }
  }
  const eid = `${Date.now().toString(36)}${rid()}`;
  const entry = { job: id, by: me.key, at: Date.now(), pts };
  if (job.freq === 'oneoff') entry.name = job.name;
  if (sweep) entry.sweep = true;
  const isNewDuck = job.freq === 'monthly' && job.duck && !S.unlocked[id];
  if (isNewDuck) entry.unlocks = true;
  const ch = { [`log.${eid}`]: entry, [`ducks.${me.key}`]: INC(pts) };
  if (isNewDuck) ch[`unlocked.${id}`] = true;
  seenLog?.add(eid);
  update(ch);

  const after = before + pts;
  const lb = levelOf(before), la = levelOf(after);
  const levelUp = la.name !== lb.name ? la.name : null;
  const by = person(me.key).name;
  if (sweep) celebrate('sweep', { title: 'Clean sweep!', sub: `All ${jobsOf('daily').length} daily jobs done today. Bonus duckies!`, pts, levelUp });
  else if (job.freq === 'daily') celebrate('daily', { title: pick(DAILY_TITLES), sub: `${job.name} · ${by}`, pts, levelUp });
  else if (job.freq === 'oneoff') {
    const tier = pts >= 10 ? 'fort' : pts >= 3 ? 'weekly' : 'daily';
    const title = tier === 'fort' ? 'Golden Duck!' : tier === 'weekly' ? 'One-off, done and dusted!' : pick(DAILY_TITLES);
    celebrate(tier, { title, sub: tier === 'daily' ? `${job.name} · ${by}` : `${job.name} done by ${by}`, pts, levelUp });
  }
  else if (job.freq === 'weekly') celebrate('weekly', { title: job.bin ? 'Bin day hero!' : 'Splendid splash!', sub: `${job.name} done by ${by}`, pts, levelUp });
  else if (job.freq === 'fortnightly') celebrate('fort', { title: 'Golden Duck!', sub: `${job.name} done by ${by}`, pts, levelUp });
  else {
    const d = job.duck || { name: 'Mystery Duck', color: '#FFC93C', hat: 'captain' };
    celebrate('monthly', {
      kicker: overdue ? 'RESCUE MISSION COMPLETE' : isNewDuck ? 'NEW RARE DUCK UNLOCKED' : 'RARE DUCK SPOTTED',
      title: d.name, duck: d, pts, levelUp,
      sub: `${job.name} · ${by}${overdue ? ` · ${st.days} days, double duckies!` : ''}`,
    });
  }
}
function undo(eid) {
  const e = S.log[eid]; if (!e) return;
  const ch = { [`log.${eid}`]: DEL, [`ducks.${e.by}`]: INC(-(e.pts || 0)) };
  if (e.unlocks) ch[`unlocked.${e.job}`] = DEL;   // that rare duck goes back in its egg
  update(ch);
  toast(`Undone: ${esc(S.jobs[e.job]?.name || e.name || 'job')}`);
}

/* ---------------- render ---------------- */
function syncBadge() {
  if (store?.kind === 'demo') return '<span class="sync demo">Demo · this phone only</span>';
  if (saveError) return `<span class="sync error" title="${esc(saveError)}">Not saved: ${esc(saveError.replace('permission-denied', 'no permission'))}</span>`;
  if (!navigator.onLine) return '<span class="sync offline">Offline · saved on phone</span>';
  if (meta.pending) return '<span class="sync pending">Syncing…</span>';
  if (meta.fromCache) return '<span class="sync offline">Saved on phone</span>';
  return '<span class="sync">Synced ✓</span>';
}

function header() {
  const total = totalDucks();
  const tallies = memberList().map((m) => `<span class="tally" style="background:${m.soft};color:${m.ink}"><span class="mini">${duck('#FFC93C', 'none')}</span>${esc(m.name)} ${Math.max(0, S.ducks[m.key] || 0)}</span>`).join('');
  return `<header class="top">
    <div class="brand"><span class="logo">${duck('#FFC93C', 'foam')}</span>
      <div><h1>Scrubber Duckies</h1><p>${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
      ${syncBadge()}</div>
    <div class="tallies">${tallies}<span class="tally level">${esc(levelOf(total).name)}</span></div>
  </header>`;
}

function jobRow(job, opts = {}) {
  const st = status(job);
  const p = st.done && st.last ? person(st.last.by) : null;
  let sub;
  if (job.freq === 'fortnightly') {
    if (!st.last) sub = 'Not done yet';
    else if (st.done) sub = `${p.name} · ${st.days === 0 ? 'today' : plural(st.days, 'day') + ' ago'} · due again in ${plural(st.dueIn, 'day')}`;
    else sub = `Overdue · last done ${plural(st.days, 'day')} ago`;
  } else if (job.freq === 'oneoff' && !st.done) {
    sub = `One-off · added by ${person(job.by).name} ${when(job.created || Date.now()).replace(/ \d\d:\d\d$/, '')}`;
  } else if (st.setDays && !st.done) sub = `${daysLabel(job.days)} · next ${nextLabel(st.next)}`;
  else sub = st.done ? `Done by ${p.name} · ${when(st.last.at)}` : (job.note || 'To do');
  const style = p ? ` style="--pc:${p.color};--ps:${p.soft};--pi:${p.ink}"` : '';
  const cls = ['job', st.done ? 'done' : '', job.freq === 'fortnightly' && st.overdue && st.last ? 'overdue' : ''].join(' ');
  return `<button class="${cls}" data-action="job" data-id="${esc(job.id)}" aria-pressed="${st.done}"${style}>
    <span class="check">${st.done ? tick : ''}</span>
    <span class="main"><span class="name">${esc(job.name)}</span><span class="sub">${esc(sub)}</span></span>
    <span class="chip ${job.freq}">+${ptsOf(job)}</span></button>`;
}
function dueRow(job) {
  const st = status(job);
  const sub = st.setDays ? `${daysLabel(job.days)} · next ${nextLabel(st.next)}`
    : job.freq === 'weekly' ? (job.note || 'Weekly')
    : !st.last ? 'Fortnightly · not done yet'
    : st.overdue ? `Fortnightly · overdue (${st.days} days)` : `Fortnightly · due in ${plural(st.dueIn, 'day')}`;
  return `<button class="job" data-action="do" data-id="${esc(job.id)}">
    <span class="check"></span>
    <span class="main"><span class="name">${esc(job.name)}</span><span class="sub ${st.overdue && st.last ? 'warn' : ''}">${esc(sub)}</span></span>
    <span class="chip ${job.freq}">+${ptsOf(job)}</span></button>`;
}
const sectionHead = (title, right) => `<div class="sec"><h2>${title}</h2><span>${right}</span></div>`;

function todayView() {
  const daily = jobsOf('daily');
  const doneN = daily.filter((j) => status(j).done).length;
  const pct = daily.length ? Math.round(doneN / daily.length * 100) : 0;
  const msg = !daily.length ? 'No daily jobs set up.' : doneN === daily.length ? 'Clean sweep! Every daily job is done.' : `${daily.length - doneN} to go. Finish them all for a Clean Sweep bonus (+5).`;

  // Reminders for jobs on set days (like the recycling): the evening before and on the day, until it's done
  let bin = '';
  for (const j of jobsOf('weekly').filter((x) => x.days?.length)) {
    const st = status(j);
    if (st.done || st.next > 1) continue;
    let extra = '';
    const black = j.bin && jobsOf('fortnightly').find((x) => x.bin);
    if (black) extra = status(black).soon ? `${black.name} is due this week too` : `${black.name} isn’t due this week`;
    bin += `<div class="bin"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>
      <div><b>${esc(j.name)} goes out ${st.next === 0 ? 'today' : 'tomorrow'}</b><span>${esc(extra || daysLabel(j.days))}</span></div></div>`;
  }

  // One-offs stay until done, then show as done for the rest of that day
  const oneoffs = jobsOf('oneoff').filter((j) => { const st = status(j); return !st.done || st.doneToday; })
    .sort((a, b) => Number(status(a).done) - Number(status(b).done) || (a.created || 0) - (b.created || 0));
  const due = [...jobsOf('weekly').filter((j) => !status(j).done), ...jobsOf('fortnightly').filter((j) => status(j).soon)];
  return `<div class="hero"><div class="row1"><span>Today’s jobs</span><b>${doneN} of ${daily.length} done</b></div>
      <div class="bar"><i style="width:${pct}%"></i></div><p>${msg}</p></div>
    ${bin}
    <section>${sectionHead('One-offs', '<button class="add-link" data-action="add-oneoff">+ Add</button>')}
      ${oneoffs.length ? oneoffs.map((j) => jobRow(j)).join('') : '<button class="add-oneoff" data-action="add-oneoff"><span>+</span>Add a one-off job</button>'}</section>
    <section>${sectionHead('Every day', `${sumPts(daily)} duckies to grab`)}${daily.map((j) => jobRow(j)).join('')}</section>
    <section>${sectionHead('Still to do this week', `${due.length} left`)}
      ${due.length ? due.map(dueRow).join('') : '<p class="happy">Everything for this week is done. Feet up!</p>'}</section>`;
}

function weekView() {
  return `<section>${sectionHead('Weekly', 'resets Monday')}${jobsOf('weekly').map((j) => jobRow(j)).join('')}</section>
    <section>${sectionHead('Fortnightly', 'golden duck')}${jobsOf('fortnightly').map((j) => jobRow(j)).join('')}</section>`;
}

function monthView() {
  const rows = jobsOf('monthly').map((j) => {
    const st = status(j);
    const unlocked = !!S.unlocked[j.id];
    const d = j.duck || { color: '#FFC93C', hat: 'captain' };
    const p = st.last ? person(st.last.by) : null;
    const age = !st.last ? 'Not done yet' : st.days === 0 ? `Done today by ${p.name}` : `Last done ${plural(st.days, 'day')} ago by ${p.name}`;
    const pct = st.last ? Math.min(100, Math.round(st.days / 60 * 100)) : 100;
    const tone = !st.last ? 'grey' : st.days <= 30 ? 'fresh' : st.days <= 45 ? 'amber' : 'red';
    return `<div class="month">
      <span class="mduck ${unlocked ? '' : 'locked'}">${duck(unlocked ? d.color : LOCKED, unlocked ? d.hat : 'none')}</span>
      <div class="main"><span class="name">${esc(j.name)}</span><span class="sub ${tone}">${esc(age)}</span>
        <span class="bar small ${tone}"><i style="width:${st.days === 0 ? 3 : pct}%"></i></span></div>
      <button class="btn ${st.done ? 'secondary' : 'dark'}" data-action="${st.done ? 'job' : 'do'}" data-id="${esc(j.id)}">${st.done ? 'Undo' : 'Done it'}</button></div>`;
  }).join('');
  return `<section><div class="intro"><h2>Monthly checks</h2><p>Not every month, but here’s how long it’s been. Each one unlocks its own rare duck, and earns double duckies if it’s been more than 45 days.</p></div>${rows}</section>`;
}

function pondView() {
  const total = totalDucks();
  const lvl = levelOf(total), nxt = nextLevel(total);
  const lpct = nxt ? Math.round((total - lvl.at) / (nxt.at - lvl.at) * 100) : 100;
  const members = memberList();
  const split = members.map((m) => `<i style="background:${m.color};flex:${Math.max(0, S.ducks[m.key] || 0) || 0.0001}"></i>`).join('');
  const names = members.map((m) => `<span style="color:${m.ink}">${esc(m.name)} · ${Math.max(0, S.ducks[m.key] || 0)}</span>`).join('');
  const monthly = jobsOf('monthly');
  const coll = monthly.map((j) => {
    const u = !!S.unlocked[j.id], d = j.duck || { name: 'Mystery Duck', color: '#FFC93C', hat: 'captain' };
    return `<div class="coll ${u ? '' : 'locked'}"><span>${duck(u ? d.color : LOCKED, u ? d.hat : 'none', u ? d.name : 'Locked duck')}</span><b>${u ? esc(d.name) : '???'}</b><small>${esc(j.name)}</small></div>`;
  }).join('');
  const recent = entries().slice(0, 12).map((e) => {
    const p = person(e.by), j = S.jobs[e.job] || (e.name ? { name: e.name } : null);
    return `<li><span class="dot" style="background:${p.color}"></span><span class="main"><b>${esc(j?.name || 'Old job')}</b><small>${esc(p.name)} · ${esc(when(e.at))}</small></span><span class="chip">+${e.pts}</span></li>`;
  }).join('');
  return `<div class="hero level"><span class="bob big-duck">${duck('#FFC93C', 'captain')}</span>
      <div><small>${esc(S.name || 'Household')} level</small><b>${esc(lvl.name)}</b><div class="bar"><i style="width:${lpct}%"></i></div>
      <span class="next">${nxt ? `${nxt.at - total} more duckies to ${esc(nxt.name)}` : 'Top of the pond!'}</span></div></div>
    <div class="card pad"><h3>The pond: ${total} duckies</h3><div class="split">${split}</div><div class="names">${names}</div></div>
    <section>${sectionHead('Rare duck collection', `${monthly.filter((j) => S.unlocked[j.id]).length} of ${monthly.length}`)}<div class="grid3">${coll}</div></section>
    <section>${sectionHead('Recently done', '')}${recent ? `<ul class="recent">${recent}</ul>` : '<p class="happy">Nothing yet. Go on, tick something off!</p>'}</section>
    <div class="card pad"><h3>Preview the celebrations</h3><div class="grid2">
      <button class="btn t-daily" data-action="demo" data-tier="daily">Daily · splash</button>
      <button class="btn t-weekly" data-action="demo" data-tier="weekly">Weekly · bubble party</button>
      <button class="btn t-fort" data-action="demo" data-tier="fort">Fortnightly · golden</button>
      <button class="btn t-month" data-action="demo" data-tier="monthly">Monthly · fireworks</button></div></div>
    <div class="card settings">
      <button class="row" data-action="sound"><span class="main">Sounds and buzzes</span><span class="toggle ${ui.sound ? 'on' : ''}" aria-hidden="true"><i></i></span></button>
      <button class="row" data-action="manage"><span class="main">Manage jobs</span><span class="chev">›</span></button>
      <button class="row" data-action="house"><span class="main">Your house <small>${esc(S.name || '')} · ${plural(memberList().length, 'person').replace('persons', 'people')}</small></span><span class="chev">›</span></button>
      ${isAdminUser ? '<button class="row" data-action="admin"><span class="main">Admin <small>Invite codes and the starter job list</small></span><span class="chev">›</span></button>' : ''}
      <button class="row" data-action="backup"><span class="main">Download a backup</span><span class="chev">›</span></button>
      <button class="row" data-action="sign-out"><span class="main">Sign out <small>${esc(me?.email || '')}</small></span><span class="chev">›</span></button>
    </div>`;
}

function sheetHTML() {
  const s = ui.sheet; if (!s) return '';
  let body = '';
  if (s.type === 'undo') {
    const e = S.log[s.eid]; const j = e && S.jobs[e.job];
    if (!e || !j) { ui.sheet = null; return ''; }
    const p = person(e.by);
    body = `<h2>${esc(j.name)}</h2><p>Done by ${esc(p.name)}, ${esc(when(e.at))}. That earned ${duckies(e.pts)}.</p>
      ${!['daily', 'weekly', 'oneoff'].includes(j.freq) ? `<button class="btn dark" data-action="again" data-id="${esc(e.job)}">Done it again today</button>` : ''}
      <button class="btn danger" data-action="undo" data-eid="${esc(s.eid)}">Undo it (take back ${e.pts})</button>
      <button class="btn ghost" data-action="close-sheet">Cancel</button>`;
  } else if (s.type === 'oneoff') {
    const p = s.pts;
    body = `<h2>Add a one-off job</h2><p>It sits at the top of Today until one of you does it.</p>
      <form class="add-job" data-action="save-oneoff">
        <label class="sr" for="oo-name">Job</label><input id="oo-name" class="field" name="name" placeholder="e.g. Clear out the garage" maxlength="80" required autocomplete="off">
        <div class="pts-row"><span class="mini-duck">${duck('#FFC93C', 'none')}</span><span class="pts-label">Duckies</span>
          <span class="stepper" role="group" aria-label="Duckies for this job">
            <button type="button" data-action="oo-pts" data-delta="-1" aria-label="One fewer duckie" ${p <= 1 ? 'disabled' : ''}>−</button>
            <b aria-live="polite">${p}</b>
            <button type="button" data-action="oo-pts" data-delta="1" aria-label="One more duckie" ${p >= 50 ? 'disabled' : ''}>+</button>
          </span></div>
        <button class="btn dark">Add to Today</button></form>
      <button class="btn ghost" data-action="close-sheet">Cancel</button>`;
  } else if (s.type === 'house') {
    const members = memberList();
    const pending = Object.values(S.pendingInvites || {}).sort((a, b) => a.at - b.at);
    body = `<h2>Your house</h2>
      <label class="fl" for="house-name">House name</label>
      <input id="house-name" class="field" data-action="rename-house" value="${esc(S.name || '')}" autocomplete="off" maxlength="60">
      <h3>People</h3>
      ${members.map((m) => `<div class="member"><span class="avatar" style="background:${m.soft};color:${m.ink}">${esc(m.name.charAt(0).toUpperCase())}</span>
        <span class="main"><b>${esc(m.name)}</b><small>${esc(m.email || '')}</small></span>
        ${m.email === me.email ? '<span class="you">You</span>' : `<button class="link danger" data-action="remove-member" data-email="${esc(m.email)}">Remove</button>`}</div>`).join('')}
      <form class="add-job" data-action="invite"><h3>Invite someone to this house</h3>
        <label class="sr" for="invite-email">Their email</label><input id="invite-email" class="field" type="email" name="email" placeholder="Their Gmail address" autocomplete="off" autocapitalize="none" required>
        <button class="btn dark">Send invite</button>
        <p class="hint">They open the app, sign in with that address and join with one tap. They’ll see all of this house’s jobs and duckies.</p></form>
      ${pending.map((p) => `<div class="member"><span class="main"><b>${esc(p.email)}</b><small>Invited, not joined yet</small></span><button class="link" data-action="copy-invite-msg" data-email="${esc(p.email)}">Copy message</button><button class="link danger" data-action="cancel-invite" data-email="${esc(p.email)}">Cancel</button></div>`).join('')}
      <button class="btn danger" data-action="leave-house">Leave this house</button>
      <button class="btn ghost" data-action="close-sheet">Done</button>`;
  } else if (s.type === 'admin') {
    const a = adminData;
    const fmt = (t) => t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
    body = !a ? '<h2>Admin</h2><p>Loading…</p>' : `<h2>Admin</h2><p>Only you can see this.</p>
      <h3>Invite codes for new houses</h3>
      <p>Each code lets one person set up their own private house. They won’t see yours.</p>
      ${a.codes.length ? a.codes.map((c) => `<div class="member code ${c.usedBy ? 'used' : ''}"><span class="main"><b>${esc(c.code)}</b><small>${c.usedBy ? `Used by ${esc(c.usedByName || 'a house')} · ${fmt(c.usedAt)}` : 'Not used yet'}</small></span>
        ${c.usedBy ? '' : `<button class="link" data-action="copy-code-msg" data-code="${esc(c.code)}">Copy invite message</button><button class="link danger" data-action="del-code" data-code="${esc(c.code)}" aria-label="Delete code ${esc(c.code)}">Delete</button>`}</div>`).join('') : '<p class="hint">No codes yet.</p>'}
      <button class="btn dark" data-action="new-code">Make a new invite code</button>
      <h3>Starter job list</h3>
      <p>New houses can start with a copy of your jobs and duckie scores. They never see your ticks, duckies or one-offs, and set bin days aren’t copied.</p>
      <p class="hint">${a.starter ? `Last updated ${fmt(a.starter.updatedAt)} · ${a.starter.jobCount} jobs` : 'Not shared yet: new houses get the original Scrubber Duckies list.'}</p>
      <button class="btn secondary" data-action="publish-starter">${a.starter ? 'Update it from my jobs' : 'Share my jobs as the starter list'}</button>
      <h3>Houses</h3>
      <p class="hint">${a.houses.map((h) => `${esc(h.name)}${h.id === hid ? ' (yours)' : ''} · ${plural(h.count, 'person').replace('persons', 'people')}`).join('<br>')}</p>
      <button class="btn ghost" data-action="close-sheet">Done</button>`;
  } else if (s.type === 'copy') {
    body = `<h2>Copy this message</h2><p>Your phone didn’t let the app copy it, so press and hold the text below, choose Select All, then Copy.</p>
      <label class="sr" for="copy-text">Invite message</label><textarea id="copy-text" class="field copy-text" readonly rows="12">${esc(s.text)}</textarea>
      <button class="btn ghost" data-action="${s.back ? 'confirm-back' : 'close-sheet'}">Done</button>`;
  } else if (s.type === 'confirm') {
    body = `<h2>${esc(s.title)}</h2><p>${esc(s.text)}</p><button class="btn danger" data-action="confirm-ok">${esc(s.ok)}</button><button class="btn ghost" data-action="${s.back ? 'confirm-back' : 'close-sheet'}">Cancel</button>`;
  } else if (s.type === 'jobs') {
    const card = (j, freq) => {
      const p = ptsOf(j), custom = freq !== 'oneoff' && Number(j.pts) > 0 && Number(j.pts) !== defaultPts(freq);
      return `<div class="edit-card">
      <div class="edit-row"><label class="sr" for="jn-${esc(j.id)}">Name</label><input id="jn-${esc(j.id)}" class="field" data-action="rename" data-id="${esc(j.id)}" value="${esc(j.name)}">
      ${freq === 'oneoff' ? '' : `<label class="sr" for="jf-${esc(j.id)}">How often</label><select id="jf-${esc(j.id)}" class="field freq" data-action="refreq" data-id="${esc(j.id)}">${Object.keys(FREQS).map((k) => `<option value="${k}"${k === freq ? ' selected' : ''}>${FREQ_SHORT[k]}</option>`).join('')}</select>`}
      <button class="icon-btn" data-action="del-job" data-id="${esc(j.id)}" aria-label="Remove ${esc(j.name)}"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button></div>
      ${freq === 'weekly' ? `<div class="day-pick" role="group" aria-label="Days for ${esc(j.name)}"><span>${j.days?.length ? 'On' : 'Days'}</span>${MON_FIRST.map((d) => `<button class="day ${j.days?.includes(d) ? 'on' : ''}" data-action="toggle-day" data-id="${esc(j.id)}" data-d="${d}" aria-pressed="${!!j.days?.includes(d)}" aria-label="${DAY_NAMES[d]}">${DAY_LETTERS[d]}</button>`).join('')}</div>` : ''}
      <div class="pts-row"><span class="mini-duck">${duck('#FFC93C', 'none')}</span><span class="pts-label">Duckies${custom ? ` <small>(usual ${defaultPts(freq)})</small>` : ''}</span>
        <span class="stepper" role="group" aria-label="Duckies for ${esc(j.name)}">
          <button data-action="pts" data-id="${esc(j.id)}" data-delta="-1" aria-label="One fewer duckie" ${p <= 1 ? 'disabled' : ''}>−</button>
          <b aria-live="polite">${p}</b>
          <button data-action="pts" data-id="${esc(j.id)}" data-delta="1" aria-label="One more duckie" ${p >= 50 ? 'disabled' : ''}>+</button>
        </span></div></div>`;
    };
    const pendingOneoffs = jobsOf('oneoff').filter((j) => !status(j).done);
    const groups = (pendingOneoffs.length ? `<h3>One-offs still to do</h3>${pendingOneoffs.map((j) => card(j, 'oneoff')).join('')}` : '')
      + Object.entries(FREQS).map(([freq, f]) => `<h3>${f.label}</h3>${jobsOf(freq).map((j) => card(j, freq)).join('')}`).join('');
    body = `<h2>Manage jobs</h2><p>Rename a job by typing over it, change how often it happens, and set how many duckies it’s worth. Weekly jobs can be set to particular days, like bin days. Removing a job keeps the duckies already earned.</p>${groups}
      <form class="add-job" data-action="add-job"><h3>Add a job</h3>
        <label class="sr" for="new-job">New job</label><input id="new-job" class="field" name="name" placeholder="e.g. Hoover the stairs" required>
        <div class="edit-row">
          <label class="sr" for="new-freq">How often</label><select id="new-freq" class="field" name="freq">${Object.entries(FREQS).map(([k, f]) => `<option value="${k}">${f.label.replace(' checks', '')}</option>`).join('')}</select>
          <label class="sr" for="new-pts">Duckies</label><input id="new-pts" class="field pts-in" name="pts" type="number" inputmode="numeric" min="1" max="50" placeholder="Duckies">
        </div>
        <button class="btn dark">Add job</button></form>
      <button class="btn ghost" data-action="close-sheet">Done</button>`;
  }
  // Only animate when a sheet first opens, not every time it's redrawn (e.g. tapping + or −)
  const enter = ui.sheetEnter ? ' enter' : '';
  ui.sheetEnter = false;
  return `<div class="sheet-bg${enter}" data-action="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`;
}

/* ---------------- not in a house yet ---------------- */
function renderOnboarding() {
  tabbar.hidden = true; sheetEl.innerHTML = sheetHTML();
  const o = onboarding;
  const logo = `<span class="logo-big bob">${duck('#FFC93C', 'foam')}</span>`;
  const signedInAs = `<p>Signed in as ${esc(me?.email)}</p>`;
  const signOut = '<button class="btn ghost" data-action="sign-out-now">Sign out</button>';
  let html;
  if (o.screen === 'loading') html = '<div class="splash"><div class="spinner"></div><p>Finding your house…</p></div>';
  else if (o.screen === 'error') {
    html = `<div class="signin">${logo}<h1>Can’t reach the app</h1>
      <p>${navigator.onLine ? `Something went wrong (${esc(o.msg)}).` : 'Your phone is offline. The first time you sign in, it needs signal to find your house.'}</p>
      <button class="btn dark" data-action="retry-house">Try again</button>${signOut}</div>`;
  } else if (o.screen === 'verify') {
    html = `<div class="signin">${logo}<h1>Check your email</h1>
      <p>We sent a link to <b>${esc(me?.email)}</b>. Tap it, then come back here.</p>
      <button class="btn dark" data-action="check-verified">I’ve tapped the link</button>
      <button class="btn ghost" data-action="resend">Send it again</button>${signOut}</div>`;
  } else if (o.screen === 'invited') {
    const inv = o.invite;
    html = `<div class="signin">${logo}<h1>You’re invited!</h1>${signedInAs}
      <div class="card pad onb-card"><small>${esc(inv.invitedBy || 'Someone')} added you to</small><b class="house-name">${esc(inv.homeName)}</b>
        <p>You’ll share the same jobs, ticks and duckie pond.</p>
        <button class="btn dark" data-action="join-house" ${o.busy ? 'disabled' : ''}>${o.busy ? 'Joining…' : `Join ${esc(inv.homeName)}`}</button>
        ${o.error ? `<p class="err">${esc(o.error)}</p>` : ''}</div>
      <button class="btn ghost" data-action="decline-invite">Not for me, decline</button>${signOut}</div>`;
  } else if (o.screen === 'create') {
    const st = o.starter;
    const radio = (id, title, desc, on) => `<label class="choice ${on ? 'on' : ''}" for="start-${id}"><input type="radio" name="start" id="start-${id}" value="${id}" ${on ? 'checked' : ''}><span><b>${title}</b><small>${desc}</small></span></label>`;
    html = `<form class="signin left" data-action="create-house">
      <button type="button" class="back" data-action="onb-welcome">‹ Back</button>
      <h1>Set up your house</h1>
      <label class="fl" for="house-new-name">House name</label>
      <input class="field" id="house-new-name" name="name" placeholder="e.g. Sam’s flat" autocomplete="off" maxlength="60" value="${esc(o.name || '')}" required>
      ${isAdminUser ? '' : `<label class="fl" for="house-code">Invite code</label>
      <input class="field code" id="house-code" name="code" placeholder="e.g. DUCK-7K2Q9" autocomplete="off" autocapitalize="characters" value="${esc(o.code || '')}" required>
      <p class="hint">Will gives you this. Each code works once.</p>`}
      <p class="fl">Start with</p>
      ${radio('starter', 'A ready-made job list', `${st?.jobCount || 29} everyday house jobs (dishwasher, laundry, bins, cleaning and monthly checks) with duckie scores. Rename, change or delete any of them.`, o.start !== 'blank')}
      ${radio('blank', 'An empty list', 'Add your own jobs from scratch.', o.start === 'blank')}
      <p class="hint">This is your own private house: nobody else sees your jobs or duckies unless you invite them.</p>
      ${o.error ? `<p class="err">${esc(o.error)}</p>` : ''}
      <button class="btn dark" ${o.busy ? 'disabled' : ''}>${o.busy ? 'Setting up…' : 'Create my house'}</button>
    </form>`;
  } else {
    html = `<div class="signin">${logo}<h1>Welcome to Scrubber Duckies</h1>${signedInAs}
      <div class="card pad onb-card"><h3>Start your own house</h3>
        <p>Your own jobs and duckies, for just you or shared with the people you live with.${isAdminUser ? '' : ' You’ll need an invite code from Will.'}</p>
        <button class="btn dark" data-action="onb-create">Set up a house</button></div>
      <div class="card pad onb-card"><h3>Joining someone’s house?</h3>
        <p>Ask them to invite <b>${esc(me?.email)}</b> from Pond → Your house, then tap below.</p>
        <button class="btn secondary" data-action="check-invite" ${o.checking ? 'disabled' : ''}>${o.checking ? 'Checking…' : 'Check for my invite'}</button>
        ${o.noInvite ? '<p class="hint">No invite yet for this email address.</p>' : ''}</div>
      ${signOut}</div>`;
  }
  app.innerHTML = html;
}

function render() {
  if (onboarding) return renderOnboarding();
  if (!S) return;
  // Keep focus, typed text and caret across re-renders (e.g. when the other phone syncs a change)
  const a = document.activeElement;
  const keep = a && a.id && a.matches('input') ? { id: a.id, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  const scrollTop = sheetEl.querySelector('.sheet')?.scrollTop;
  tabbar.hidden = false;
  for (const b of tabbar.querySelectorAll('button')) b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false');
  const view = { today: todayView, week: weekView, month: monthView, pond: pondView }[ui.tab] || todayView;
  app.innerHTML = header() + `<main class="view">${view()}</main>`;
  sheetEl.innerHTML = sheetHTML();
  if (scrollTop != null && sheetEl.querySelector('.sheet')) sheetEl.querySelector('.sheet').scrollTop = scrollTop;
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch {} }
  }
}

/* ---------------- sign-in screens ---------------- */
const googleG = '<svg width="20" height="20" viewBox="0 0 48 48" style="background:#fff;border-radius:50%;padding:2px"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
function renderSignIn(msg = '', mode = 'in') {
  tabbar.hidden = true; sheetEl.innerHTML = '';
  app.innerHTML = `<form class="signin" data-action="${mode === 'up' ? 'sign-up' : 'sign-in'}">
    <span class="logo-big bob">${duck('#FFC93C', 'foam')}</span>
    <h1>Scrubber Duckies</h1>
    <p>${mode === 'up' ? 'Create an account with your email address. You’ll get an email to confirm it.' : 'Sign in once on each phone. It stays signed in, even offline.'}</p>
    ${mode === 'in' ? `<button type="button" class="btn primary" data-action="google">${googleG}Continue with Google</button>
    <p class="note">or use email and password</p>` : ''}
    <label class="sr" for="si-email">Email</label><input id="si-email" class="field" type="email" name="email" placeholder="Email" autocomplete="username" required>
    <label class="sr" for="si-pass">Password</label><input id="si-pass" class="field" type="password" name="password" placeholder="Password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" minlength="6" required>
    <div class="err">${esc(msg)}</div>
    <button class="btn dark">${mode === 'up' ? 'Create account' : 'Sign in'}</button>
    <button type="button" class="btn ghost" data-action="${mode === 'up' ? 'show-sign-in' : 'show-sign-up'}">${mode === 'up' ? 'I already have an account' : 'First time with email? Create an account'}</button>
    ${mode === 'in' ? '<button type="button" class="btn ghost" data-action="forgot">Forgot password</button>' : ''}
  </form>`;
}
function renderMessage(title, text, buttons) {
  tabbar.hidden = true; sheetEl.innerHTML = '';
  app.innerHTML = `<div class="signin"><span class="logo-big">${duck(LOCKED, 'none')}</span><h1>${title}</h1><p>${text}</p>${buttons}</div>`;
}
function friendlyAuth(e) {
  const c = e?.code || '';
  if (c.includes('popup-closed') || c.includes('cancelled-popup')) return '';
  if (c.includes('wrong-password') || c.includes('invalid-credential') || c.includes('user-not-found')) return 'That email and password don’t match.';
  if (c.includes('email-already-in-use')) return 'That email already has an account. Sign in instead.';
  if (c.includes('weak-password')) return 'Use a password of at least 6 characters.';
  if (c.includes('network')) return 'No signal. Signing in needs signal the first time.';
  if (c.includes('popup-blocked')) return 'The sign-in window was blocked. Try again, or use email and password.';
  return e?.message || 'Something went wrong. Try again.';
}

/* ---------------- actions ---------------- */
let confirmFn = null;
function openSheet(s) { const fresh = !ui.sheet; ui.sheet = s; ui.sheetEnter = fresh; sheetEl.innerHTML = sheetHTML(); }
function closeSheet() { ui.sheet = null; confirmFn = null; sheetEl.innerHTML = ''; }
/** The app's own address, wherever it's hosted */
const appLink = () => location.origin + location.pathname.replace(/index\.html$/, '');
/** Copy to the clipboard; if the phone won't allow it, show the text so it can be copied by hand */
async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done, 3000); }
  catch { openSheet({ type: 'copy', text, back: ui.sheet && ui.sheet.type !== 'copy' ? { ...ui.sheet } : null }); }
}
function openConfirm(title, text, ok, fn, back = null) {
  ui.sheet = { type: 'confirm', title, text, ok, back };
  confirmFn = fn;
  if (!sheetEl.innerHTML) ui.sheetEnter = true;
  sheetEl.innerHTML = sheetHTML();
}
function readCreateForm() {
  const f = document.querySelector('form[data-action=create-house]'); if (!f) return {};
  return { name: f.querySelector('[name=name]')?.value || '', code: f.querySelector('[name=code]')?.value || '', start: f.querySelector('input[name=start]:checked')?.value || 'starter' };
}

const click = {
  tab(el) { ui.tab = el.dataset.tab; ls.set('sd.tab', ui.tab); closeSheet(); render(); scrollTo(0, 0); },
  job(el) {
    const id = el.dataset.id, job = { id, ...S.jobs[id] };
    const st = status(job);
    if (st.done && st.last) openSheet({ type: 'undo', eid: st.last.eid });
    else complete(id);
  },
  do(el) { complete(el.dataset.id); },
  again(el) { closeSheet(); complete(el.dataset.id); },
  undo(el) { const eid = el.dataset.eid; closeSheet(); undo(eid); },
  'close-sheet'() { closeSheet(); },
  'confirm-back'() { const back = ui.sheet?.back; closeSheet(); if (back) openSheet(back); },
  'sheet-bg'(el, ev) { if (ev.target === el) closeSheet(); },
  'confirm-ok'() { const fn = confirmFn, back = ui.sheet?.back; closeSheet(); if (back) openSheet(back); fn?.(); },
  'close-cel'() { closeCel(); },
  demo(el) {
    const by = person(me.key).name;
    const t = el.dataset.tier;
    if (t === 'daily') celebrate('daily', { title: 'Squeaky clean!', sub: `Dishwasher · ${by}`, pts: 1 });
    if (t === 'weekly') celebrate('weekly', { title: 'Splendid splash!', sub: `Clean bathroom done by ${by}`, pts: 3 });
    if (t === 'fort') celebrate('fort', { title: 'Golden Duck!', sub: `Clean office done by ${by}`, pts: 5 });
    if (t === 'monthly') celebrate('monthly', { kicker: 'PREVIEW', title: 'Captain Suds', sub: `Clean dishwasher · ${by}`, pts: 10, duck: { color: '#FFC93C', hat: 'captain' } });
  },
  sound() { ui.sound = !ui.sound; ls.set('sd.sound', ui.sound ? '1' : '0'); render(); if (ui.sound) squeak(1); },
  manage() { openSheet({ type: 'jobs' }); },
  'add-oneoff'() { openSheet({ type: 'oneoff', pts: ONEOFF_PTS }); setTimeout(() => document.getElementById('oo-name')?.focus(), 50); },
  'oo-pts'(el) {
    const name = document.getElementById('oo-name')?.value || '';
    ui.sheet.pts = Math.min(50, Math.max(1, ui.sheet.pts + Number(el.dataset.delta)));
    sheetEl.innerHTML = sheetHTML();
    document.getElementById('oo-name').value = name;
  },
  pts(el) {
    const id = el.dataset.id, job = S.jobs[id]; if (!job) return;
    const n = Math.min(50, Math.max(1, ptsOf(job) + Number(el.dataset.delta)));
    update({ [`jobs.${id}.pts`]: n === FREQS[job.freq]?.pts ? DEL : n });
  },
  'toggle-day'(el) {
    const id = el.dataset.id, d = Number(el.dataset.d), job = S.jobs[id];
    const days = new Set(job.days || []);
    days.has(d) ? days.delete(d) : days.add(d);
    const list = MON_FIRST.filter((x) => days.has(x));
    update({ [`jobs.${id}.days`]: list.length ? list : DEL, ...(job.note && list.length ? { [`jobs.${id}.note`]: DEL } : {}) });
  },
  'del-job'(el) {
    const id = el.dataset.id, name = S.jobs[id]?.name;
    openConfirm(`Remove “${name}”?`, 'It comes off the lists. Duckies already earned are kept.', 'Remove job', () => { update({ [`jobs.${id}`]: DEL }); toast(`Removed ${esc(name)}`); }, { type: 'jobs' });
  },
  backup() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `scrubber-duckies-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'sign-out'() { openConfirm('Sign out?', 'You’ll need signal to sign back in.', 'Sign out', () => click['sign-out-now']()); },
  /* -- your house -- */
  house() { openSheet({ type: 'house' }); },
  'remove-member'(el) {
    const who = el.dataset.email, name = S.members?.[keyOf(who)]?.name || who;
    openConfirm(`Remove ${name}?`, 'They’ll stop seeing this house’s jobs and duckies. Their duckies stay in the pond. You can invite them again later.', 'Remove', () => {
      store.removeMember(who).then(() => toast(`${esc(name)} removed`)).catch((e) => toast(`Couldn’t remove: ${esc(e.code || e.message)}`));
    }, { type: 'house' });
  },
  'leave-house'() {
    const last = (S.memberEmails || []).length <= 1;
    openConfirm('Leave this house?', last ? 'You’re the only person in it, so the house and all its jobs and duckies will be deleted.' : 'You’ll stop seeing this house’s jobs and duckies. Someone can invite you back.', last ? 'Leave and delete' : 'Leave', async () => {
      unsub?.(); unsub = null;   // stop listening first, so leaving doesn't look like being removed
      try { await store.removeMember(me.email); } catch (e) { startData(); return toast(`Couldn’t leave: ${esc(e.code || e.message)}`); }
      leaveHouseLocally(); resolveHouse();
    });
  },
  async 'cancel-invite'(el) { try { await store.cancelInvite(el.dataset.email); toast('Invite cancelled'); } catch (e) { toast(`Couldn’t cancel: ${esc(e.code || e.message)}`); } },
  /* -- admin -- */
  admin() { openSheet({ type: 'admin' }); loadAdmin(); },
  async 'new-code'() {
    try { const code = await store.newCode(); await loadAdmin(); toast(`New code: ${esc(code)}`); } catch (e) { toast(`Couldn’t make a code: ${esc(e.code || e.message)}`); }
  },
  'copy-code-msg'(el) {
    const code = el.dataset.code;
    copyText(`🦆 You're invited to Scrubber Duckies, an app for keeping on top of house jobs (with a rubber duckie for every job done)!

1. Open this link in your browser: ${appLink()}
2. Sign in with Google, or with an email and password
3. Tap "Set up a house" and enter your code: ${code}
4. Choose the ready-made job list or start empty
5. Add it to your home screen (Share → Add to Home Screen) and it will look and behave just like an installed app

The code works once. If Google sign-in won't work, copy the link straight into Safari or Chrome rather than opening it from here.`, 'Invite message copied. Paste it into WhatsApp or an email.');
  },
  'copy-invite-msg'(el) {
    const email = el.dataset.email;
    copyText(`🦆 I've added you to ${S.name || 'our house'} on Scrubber Duckies, our house jobs app!

1. Open this link in your browser: ${appLink()}
2. Sign in with Google using ${email}
3. Tap "Join ${S.name || 'the house'}"
4. Add it to your home screen (Share → Add to Home Screen) and it will look and behave just like an installed app

If Google sign-in won't work, copy the link straight into Safari or Chrome rather than opening it from here.`, 'Invite message copied. Paste it into WhatsApp or an email.');
  },
  async 'copy-code'(el) {
    const code = el.dataset.code;
    try { await navigator.clipboard.writeText(code); toast(`${esc(code)} copied`); } catch { toast(esc(code)); }
  },
  'del-code'(el) {
    openConfirm(`Delete ${el.dataset.code}?`, 'Nobody will be able to use this code.', 'Delete', async () => { await store.deleteCode(el.dataset.code).catch(() => {}); loadAdmin(); }, { type: 'admin' });
  },
  'publish-starter'() {
    const n = Object.values(S.jobs).filter((j) => j.freq !== 'oneoff').length;
    openConfirm('Share your job list?', `New houses will be able to start with your ${n} jobs and their duckie scores. Houses already set up aren’t affected.`, 'Share job list', async () => {
      try { await store.publishStarter(S.jobs); toast('Starter job list updated'); } catch (e) { toast(`Couldn’t share it: ${esc(e.code || e.message)}`); }
      loadAdmin();
    }, { type: 'admin' });
  },
  /* -- onboarding -- */
  async 'onb-create'() {
    onboarding = { screen: 'create', starter: null }; render();
    try { const st = await store.starterInfo(); if (onboarding?.screen === 'create') { Object.assign(onboarding, readCreateForm(), { starter: st }); render(); } } catch { /* built-in list */ }
  },
  'onb-welcome'() { onboarding = { screen: 'welcome' }; render(); },
  async 'check-invite'() {
    onboarding = { screen: 'welcome', checking: true }; render();
    try {
      const inv = await store.getInvite();
      onboarding = inv ? { screen: 'invited', invite: inv } : { screen: 'welcome', noInvite: true };
    } catch { onboarding = { screen: 'welcome', noInvite: true }; }
    render();
  },
  async 'join-house'() {
    onboarding.busy = true; onboarding.error = null; render();
    try { const name = onboarding.invite.homeName; ui.tab = 'today'; openHouse(await store.joinHouse(onboarding.invite)); toast(`Welcome to ${esc(name)}!`); }
    catch (e) { onboarding.busy = false; onboarding.error = e.friendly || `Couldn’t join: ${e.code || e.message}`; render(); }
  },
  'decline-invite'() {
    openConfirm('Decline this invite?', 'They can always invite you again.', 'Decline', async () => {
      await store.declineInvite().catch(() => {}); onboarding = { screen: 'welcome' }; render();
    });
  },
  'retry-house'() { resolveHouse(); },
  async google() { try { await store.google(); } catch (e) { renderSignIn(friendlyAuth(e)); } },
  'show-sign-up'() { renderSignIn('', 'up'); },
  'show-sign-in'() { renderSignIn(''); },
  async forgot() {
    const email = app.querySelector('input[name=email]')?.value.trim();
    if (!email) return renderSignIn('Type your email first, then tap Forgot password.');
    try { await store.reset(email); toast('Password reset email sent'); } catch (e) { renderSignIn(friendlyAuth(e)); }
  },
  async 'check-verified'() { try { me = await store.reloadUser(); } catch {} if (me?.verified) resolveHouse(); else toast('Not verified yet. Check your email (and spam).'); },
  async 'resend'() { try { await store.sendVerification(); toast('Sent again'); } catch (e) { toast(esc(friendlyAuth(e))); } },
  'sign-out-now'() { closeSheet(); leaveHouseLocally(); onboarding = null; store.signOut(); },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM' || el.tagName === 'INPUT') return;
  const fn = click[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el, ev); }
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset?.action === 'rename') {
    const name = el.value.trim();
    if (name && name !== S.jobs[el.dataset.id]?.name) { update({ [`jobs.${el.dataset.id}.name`]: name }); toast('Renamed'); }
  }
  if (el.dataset?.action === 'rename-house') {
    const name = el.value.trim();
    if (name && name !== S.name) { update({ name }); toast('House renamed'); }
  }
  if (el.dataset?.action === 'refreq') {
    const id = el.dataset.id, freq = el.value, job = S.jobs[id];
    if (!job || job.freq === freq) return;
    const ch = { [`jobs.${id}.freq`]: freq };
    if (Number(job.pts) === FREQS[freq].pts) ch[`jobs.${id}.pts`] = DEL;
    if (freq === 'monthly' && !job.duck) ch[`jobs.${id}.duck`] = spareDuck();
    update(ch);
    toast(`${esc(job.name)} is now ${FREQ_SHORT[freq].toLowerCase()}`);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && ['rename', 'rename-house'].includes(e.target.dataset?.action)) e.target.blur();
  if (e.key === 'Escape') { if (celEl.innerHTML) closeCel(); else if (ui.sheet) closeSheet(); }
});
document.addEventListener('submit', async (ev) => {
  const f = ev.target; ev.preventDefault();
  const a = f.dataset.action;
  if (a === 'create-house') {
    Object.assign(onboarding, readCreateForm());
    const name = onboarding.name.trim(), code = isAdminUser ? '' : onboarding.code.trim().toUpperCase().replace(/\s+/g, '');
    if (!name) return;
    onboarding.busy = true; onboarding.error = null; render();
    try {
      const id = await store.createHouse({ name, code, starter: onboarding.start !== 'blank' });
      ui.tab = 'today'; openHouse(id); toast(`${esc(name)} is ready`);
    } catch (e) { onboarding.busy = false; onboarding.error = e.friendly || `Couldn’t set it up: ${e.code || e.message}`; render(); }
    return;
  }
  if (a === 'invite') {
    const input = f.querySelector('[name=email]');
    const to = input.value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return toast('That doesn’t look like an email address');
    input.blur();
    try { await store.invite(to); input.value = ''; toast(`Invite sent to ${esc(to)}`); }
    catch (e) { toast(esc(e.friendly || `Couldn’t invite: ${e.code || e.message}`)); }
    return;
  }
  if (a === 'save-oneoff') {
    const name = f.querySelector('[name=name]').value.trim();
    if (!name) return;
    const id = `o-${Date.now().toString(36)}${rid()}`;
    update({ [`jobs.${id}`]: { name, freq: 'oneoff', pts: ui.sheet?.pts || ONEOFF_PTS, by: me.key, created: Date.now(), order: Date.now() } });
    closeSheet();
    toast(`Added ${esc(name)} to Today`);
    return;
  }
  if (a === 'add-job') {
    const name = f.querySelector('[name=name]').value.trim(), freq = f.querySelector('[name=freq]').value;
    if (!name) return;
    const id = (() => { let base = `${freq[0]}-${slug(name)}`, k = base, n = 2; while (S.jobs[k]) k = `${base}-${n++}`; return k; })();
    const job = { name, freq, order: Math.max(0, ...Object.values(S.jobs).map((j) => j.order || 0)) + 1 };
    const pts = Math.round(Number(f.querySelector('[name=pts]').value));
    if (pts >= 1 && pts <= 50 && pts !== FREQS[freq].pts) job.pts = pts;
    if (freq === 'monthly') job.duck = spareDuck();
    update({ [`jobs.${id}`]: job });
    toast(`Added ${esc(name)}`);
    f.reset();
    return;
  }
  const email = f.querySelector('[name=email]')?.value.trim(), password = f.querySelector('[name=password]')?.value;
  try {
    if (a === 'sign-in') await store.signIn(email, password);
    if (a === 'sign-up') await store.signUp(email, password);
  } catch (e) { renderSignIn(friendlyAuth(e), a === 'sign-up' ? 'up' : 'in'); }
});
addEventListener('online', () => S && render());
addEventListener('offline', () => S && render());
// Roll over at midnight / when the app comes back to the front
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S) render(); });
setInterval(() => { if (S && !ui.sheet && document.visibilityState === 'visible') render(); }, 60_000);

/* ---------------- data ---------------- */
function noticeOthers() {
  if (!S) return;
  const fresh = [];
  for (const [eid, e] of Object.entries(S.log)) {
    if (seenLog.has(eid)) continue;
    seenLog.add(eid);
    if (e.by !== me.key && Date.now() - e.at < 30 * 60_000) fresh.push(e);
  }
  if (fresh.length) {
    const e = fresh.sort((a, b) => b.at - a.at)[0];
    const p = person(e.by), more = fresh.length > 1 ? ` and ${fresh.length - 1} more` : '';
    toast(`<span class="toast-duck">${duck('#FFC93C', 'foam')}</span><span><b>${esc(p.name)}</b> did ${esc(S.jobs[e.job]?.name || e.name || 'a job')}${more} · +${fresh.reduce((a, x) => a + (x.pts || 0), 0)}</span>`, 3500);
  }
}
/** Keeps the document small: log entries over 120 days old go, except each job's latest. */
function prune() {
  if (pruned || meta.fromCache) return;
  pruned = true;
  const cutoff = Date.now() - 120 * 864e5;
  const latest = {};
  for (const [eid, e] of Object.entries(S.log)) if (!latest[e.job] || e.at > S.log[latest[e.job]].at) latest[e.job] = eid;
  const keepIds = new Set(Object.values(latest));
  const ch = {};
  for (const [eid, e] of Object.entries(S.log)) if (e.at < cutoff && !keepIds.has(eid)) ch[`log.${eid}`] = DEL;
  for (const j of jobsOf('oneoff')) { const st = status(j); if (st.done && st.days > 7) ch[`jobs.${j.id}`] = DEL; }
  if (Object.keys(ch).length) update(ch);
}
async function loadAdmin() {
  if (!isAdminUser) return;
  try { adminData = await store.admin(); } catch (e) { console.warn('admin', e); }
  if (ui.sheet?.type === 'admin') sheetEl.innerHTML = sheetHTML();
}
function leaveHouseLocally() {
  unsub?.(); unsub = null; store?.close?.();
  if (me) { try { localStorage.removeItem(`sd.hid:${me.uid}`); } catch {} }
  hid = null; S = null; ui.sheet = null; closeCel();
}
function openHouse(id) {
  hid = id; ls.set(`sd.hid:${me.uid}`, id);
  onboarding = null; store.open(id); startData();
}
/** Find this person's house (or an invite to one) and open it. */
async function resolveHouse() {
  me = store.me();
  if (!me) return;
  if (!me.verified) { onboarding = { screen: 'verify' }; return render(); }
  onboarding = { screen: 'loading' }; render();
  isAdminUser = ls.get(`sd.admin:${me.uid}`) === '1';
  store.isAdmin().then((v) => { isAdminUser = v; ls.set(`sd.admin:${me.uid}`, v ? '1' : '0'); render(); }).catch(() => {});
  try {
    const id = await store.findHouse();
    if (id) return openHouse(id);
    const inv = await store.getInvite().catch(() => null);
    onboarding = inv ? { screen: 'invited', invite: inv } : { screen: 'welcome' };
  } catch (e) {
    console.error(e);
    onboarding = { screen: 'error', msg: e.code || e.message };
  }
  render();
}
function startData() {
  unsub?.();
  seenLog = null; pruned = false;
  let ensured = false;
  app.innerHTML = '<div class="splash"><div class="spinner"></div><p>Filling the bath…</p></div>';
  unsub = store.start((data, m) => {
    meta = m;
    if (!data && !m.fromCache) { leaveHouseLocally(); return resolveHouse(); }   // house deleted
    if (!data) return;
    S = normalize(data);
    if (!seenLog) seenLog = new Set(Object.keys(S.log));
    else noticeOthers();
    // Keep my name and an entry in the duck tally
    if (!m.fromCache && !ensured) {
      ensured = true;
      const ch = {};
      if (!S.members[me.key]) ch[`members.${me.key}`] = { name: me.name, email: me.email, joined: Date.now() };
      if (S.ducks[me.key] == null) ch[`ducks.${me.key}`] = 0;
      if (!S.name) ch.name = 'Our house';
      // The original house from before sharing: everyone already in it stays in it, even if they haven't opened the new version yet
      if (hid === 'main') {
        const missing = Object.values(S.members).map((m) => (m.email || '').toLowerCase()).filter((e) => e && !S.memberEmails.includes(e));
        if (missing.length) ch.memberEmails = [...S.memberEmails, ...missing];
      }
      if (Object.keys(ch).length) update(ch);
    }
    prune();
    render();
  }, (err) => {
    console.error(err);
    if (err.code === 'permission-denied') { leaveHouseLocally(); toast('You’re no longer in that house'); return resolveHouse(); }
    renderMessage('Can’t open the house', esc(err.message), '<button class="btn dark" data-action="sign-out-now">Sign out</button>');
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  const params = new URLSearchParams(location.search);
  if (!firebaseConfig || params.has('demo')) { store = demoStore(); resolveHouse(); return; }
  try { store = await firebaseStore(); }
  catch (e) {
    console.error(e);
    renderMessage('Couldn’t start', 'The app needs signal the very first time it opens on a phone, to download what it needs for offline use. Try again with signal.', '<button class="btn dark" onclick="location.reload()">Try again</button>');
    return;
  }
  store.onAuth((user) => {
    if (user) resolveHouse();
    else { leaveHouseLocally(); onboarding = null; me = null; renderSignIn(); }
  });
}

/* ---------------- updates ----------------
 * When a new version has been published, the service worker downloads it in the background.
 * Once it's ready we show a banner with a Reload button. */
function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.innerHTML = '<span><b>Update ready</b>A new version of the app has downloaded.</span><button type="button">Reload</button>';
  el.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(el);
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showUpdateBanner(); });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {}); });
  }).catch(() => {});
}
boot();
