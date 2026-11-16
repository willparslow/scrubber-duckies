import { firebaseConfig, FIREBASE_VERSION } from './firebase-config.js';

/* ------------------------------------------------------------------ *
 *  Scrubber Duckies: our house jobs, with a duckie for every one done.
 *  Everything lives in ONE Firestore document (homes/main) shared by the
 *  two of you. Firestore's offline cache keeps it working with no signal;
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
let blocked = false;  // signed in with an account that isn't on the list
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
const ptsOf = (job) => Number(job.pts) > 0 ? Number(job.pts) : FREQS[job.freq].pts;
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
      if (name === 'Recycling') { jobs[id].days = [1, 4]; jobs[id].bin = true; }
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
function newHouse(person) {
  return {
    jobs: defaultJobs(), log: {}, ducks: { [person.key]: 0 }, unlocked: {},
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
 * Both stores expose the same API. The demo one keeps the house in this browser
 * (open two tabs with ?as=will@demo.test and ?as=tessa@demo.test to see syncing). */
function demoStore() {
  const params = new URLSearchParams(location.search);
  const email = (params.get('as') || 'will@demo.test').toLowerCase();
  const KEY = 'sd.fakedb';
  const load = () => { try { return JSON.parse(ls.get(KEY)) || null; } catch { return null; } };
  let db = load() || { home: null };
  const save = () => { ls.set(KEY, JSON.stringify(db)); emit(); };
  const user = { uid: keyOf(email), email, key: keyOf(email), name: firstName(email.split('@')[0].replace(/^./, (c) => c.toUpperCase())), verified: true };
  let cb = null;
  function emit() { cb?.(db.home ? structuredClone(db.home) : null, { exists: !!db.home }); }
  addEventListener('storage', (e) => { if (e.key === KEY) { db = load() || db; emit(); } });
  return {
    kind: 'demo',
    me: () => user,
    start(fn) {
      cb = fn;
      if (!db.home) { db.home = newHouse(user); ls.set(KEY, JSON.stringify(db)); }
      setTimeout(emit, 0);
      return () => { cb = null; };
    },
    update(changes) { for (const [p, v] of Object.entries(changes)) setPath(db.home, p, v); save(); },
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
  const ref = fs.doc(db, 'homes', 'main');
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
    start(fn, onErr) {
      let creating = false;
      return fs.onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
        const m = { exists: snap.exists(), fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites };
        if (!snap.exists() && !snap.metadata.fromCache && !creating) {
          // First person ever to open the app sets the house up (a transaction, so two phones can't both do it)
          creating = true;
          fs.runTransaction(db, async (tx) => { const s = await tx.get(ref); if (!s.exists()) tx.set(ref, newHouse(meNow())); })
            .catch((e) => onErr(e));
        }
        fn(snap.exists() ? snap.data() : null, m);
      }, onErr);
    },
    // Not awaited: when offline, Firestore applies the change locally at once and queues it.
    update(changes) {
      fs.updateDoc(ref, toFs(changes)).then(() => { if (saveError) { saveError = null; render(); } }).catch((e) => {
        console.error('Save failed', e);
        saveError = e.code || e.message; render();
      });
    },
  };
}

/* ---------------- derived data ---------------- */
function normalize(d) {
  d.jobs ||= {}; d.log ||= {}; d.ducks ||= {}; d.unlocked ||= {}; d.members ||= {};
  return d;
}
const jobsOf = (freq) => Object.entries(S.jobs).filter(([, j]) => j.freq === freq).map(([id, j]) => ({ id, ...j })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const entries = () => Object.entries(S.log).map(([eid, e]) => ({ eid, ...e })).sort((a, b) => b.at - a.at);
function lastFor(jobId) { let best = null; for (const [eid, e] of Object.entries(S.log)) if (e.job === jobId && (!best || e.at > best.at)) best = { eid, ...e }; return best; }
function memberList() {
  return Object.entries(S.members).map(([key, m]) => ({ key, ...m })).sort((a, b) => (a.joined || 0) - (b.joined || 0))
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
  toast(`Undone: ${esc(S.jobs[e.job]?.name || 'job')}`);
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

  const due = [...jobsOf('weekly').filter((j) => !status(j).done), ...jobsOf('fortnightly').filter((j) => status(j).soon)];
  return `<div class="hero"><div class="row1"><span>Today’s jobs</span><b>${doneN} of ${daily.length} done</b></div>
      <div class="bar"><i style="width:${pct}%"></i></div><p>${msg}</p></div>
    ${bin}
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
    const p = person(e.by), j = S.jobs[e.job];
    return `<li><span class="dot" style="background:${p.color}"></span><span class="main"><b>${esc(j?.name || 'Old job')}</b><small>${esc(p.name)} · ${esc(when(e.at))}</small></span><span class="chip">+${e.pts}</span></li>`;
  }).join('');
  return `<div class="hero level"><span class="bob big-duck">${duck('#FFC93C', 'captain')}</span>
      <div><small>Household level</small><b>${esc(lvl.name)}</b><div class="bar"><i style="width:${lpct}%"></i></div>
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
      ${j.freq !== 'daily' && j.freq !== 'weekly' ? `<button class="btn dark" data-action="again" data-id="${esc(e.job)}">Done it again today</button>` : ''}
      <button class="btn danger" data-action="undo" data-eid="${esc(s.eid)}">Undo it (take back ${e.pts})</button>
      <button class="btn ghost" data-action="close-sheet">Cancel</button>`;
  } else if (s.type === 'confirm') {
    body = `<h2>${esc(s.title)}</h2><p>${esc(s.text)}</p><button class="btn danger" data-action="confirm-ok">${esc(s.ok)}</button><button class="btn ghost" data-action="close-sheet">Cancel</button>`;
  } else if (s.type === 'jobs') {
    const card = (j, freq) => {
      const p = ptsOf(j), custom = Number(j.pts) > 0 && Number(j.pts) !== FREQS[freq].pts;
      return `<div class="edit-card">
      <div class="edit-row"><label class="sr" for="jn-${esc(j.id)}">Name</label><input id="jn-${esc(j.id)}" class="field" data-action="rename" data-id="${esc(j.id)}" value="${esc(j.name)}">
      <label class="sr" for="jf-${esc(j.id)}">How often</label><select id="jf-${esc(j.id)}" class="field freq" data-action="refreq" data-id="${esc(j.id)}">${Object.keys(FREQS).map((k) => `<option value="${k}"${k === freq ? ' selected' : ''}>${FREQ_SHORT[k]}</option>`).join('')}</select>
      <button class="icon-btn" data-action="del-job" data-id="${esc(j.id)}" aria-label="Remove ${esc(j.name)}"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button></div>
      ${freq === 'weekly' ? `<div class="day-pick" role="group" aria-label="Days for ${esc(j.name)}"><span>${j.days?.length ? 'On' : 'Days'}</span>${MON_FIRST.map((d) => `<button class="day ${j.days?.includes(d) ? 'on' : ''}" data-action="toggle-day" data-id="${esc(j.id)}" data-d="${d}" aria-pressed="${!!j.days?.includes(d)}" aria-label="${DAY_NAMES[d]}">${DAY_LETTERS[d]}</button>`).join('')}</div>` : ''}
      <div class="pts-row"><span class="mini-duck">${duck('#FFC93C', 'none')}</span><span class="pts-label">Duckies${custom ? ` <small>(usual ${FREQS[freq].pts})</small>` : ''}</span>
        <span class="stepper" role="group" aria-label="Duckies for ${esc(j.name)}">
          <button data-action="pts" data-id="${esc(j.id)}" data-delta="-1" aria-label="One fewer duckie" ${p <= 1 ? 'disabled' : ''}>−</button>
          <b aria-live="polite">${p}</b>
          <button data-action="pts" data-id="${esc(j.id)}" data-delta="1" aria-label="One more duckie" ${p >= 50 ? 'disabled' : ''}>+</button>
        </span></div></div>`;
    };
    const groups = Object.entries(FREQS).map(([freq, f]) => `<h3>${f.label}</h3>${jobsOf(freq).map((j) => card(j, freq)).join('')}`).join('');
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
  return `<div class="sheet-bg" data-action="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`;
}

function render() {
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
    <p>${mode === 'up' ? 'Create your account with one of the two email addresses in the setup.' : 'Sign in once on each phone. It stays signed in, even offline.'}</p>
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
function openSheet(s) { ui.sheet = s; sheetEl.innerHTML = sheetHTML(); }
function closeSheet() { ui.sheet = null; confirmFn = null; sheetEl.innerHTML = ''; }

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
  'sheet-bg'(el, ev) { if (ev.target === el) closeSheet(); },
  'confirm-ok'() { const fn = confirmFn; closeSheet(); fn?.(); },
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
  pts(el) {
    const id = el.dataset.id, job = S.jobs[id]; if (!job) return;
    const n = Math.min(50, Math.max(1, ptsOf(job) + Number(el.dataset.delta)));
    update({ [`jobs.${id}.pts`]: n === FREQS[job.freq].pts ? DEL : n });
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
    ui.sheet = { type: 'confirm', title: `Remove “${name}”?`, text: 'It comes off the lists. Duckies already earned are kept.', ok: 'Remove job' };
    confirmFn = () => { update({ [`jobs.${id}`]: DEL }); toast(`Removed ${esc(name)}`); openSheet({ type: 'jobs' }); };
    sheetEl.innerHTML = sheetHTML();
  },
  backup() {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `scrubber-duckies-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'sign-out'() {
    ui.sheet = { type: 'confirm', title: 'Sign out?', text: 'You’ll need signal to sign back in.', ok: 'Sign out' };
    confirmFn = () => { unsub?.(); unsub = null; S = null; store.signOut(); };
    sheetEl.innerHTML = sheetHTML();
  },
  async google() { try { await store.google(); } catch (e) { renderSignIn(friendlyAuth(e)); } },
  'show-sign-up'() { renderSignIn('', 'up'); },
  'show-sign-in'() { renderSignIn(''); },
  async forgot() {
    const email = app.querySelector('input[name=email]')?.value.trim();
    if (!email) return renderSignIn('Type your email first, then tap Forgot password.');
    try { await store.reset(email); toast('Password reset email sent'); } catch (e) { renderSignIn(friendlyAuth(e)); }
  },
  async 'check-verified'() { me = await store.reloadUser(); if (me.verified) startData(); else toast('Not verified yet. Check your email.'); },
  async 'resend'() { try { await store.sendVerification(); toast('Sent again'); } catch (e) { toast(esc(friendlyAuth(e))); } },
  'sign-out-now'() { unsub?.(); unsub = null; S = null; blocked = false; store.signOut(); },
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
  if (e.key === 'Enter' && e.target.dataset?.action === 'rename') e.target.blur();
  if (e.key === 'Escape') { if (celEl.innerHTML) closeCel(); else if (ui.sheet) closeSheet(); }
});
document.addEventListener('submit', async (ev) => {
  const f = ev.target; ev.preventDefault();
  const a = f.dataset.action;
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
    toast(`<span class="toast-duck">${duck('#FFC93C', 'foam')}</span><span><b>${esc(p.name)}</b> did ${esc(S.jobs[e.job]?.name || 'a job')}${more} · +${fresh.reduce((a, x) => a + (x.pts || 0), 0)}</span>`, 3500);
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
  if (Object.keys(ch).length) update(ch);
}
function startData() {
  unsub?.();
  me = store.me();
  seenLog = null; pruned = false;
  app.innerHTML = '<div class="splash"><div class="spinner"></div><p>Filling the bath…</p></div>';
  unsub = store.start((data, m) => {
    meta = m;
    if (!data) return;   // being created
    S = normalize(data);
    if (!seenLog) seenLog = new Set(Object.keys(S.log));
    else noticeOthers();
    // Join the house, and keep my name and an entry in the duck tally
    if (!m.fromCache && (!S.members[me.key] || S.ducks[me.key] == null)) {
      const ch = {};
      if (!S.members[me.key]) ch[`members.${me.key}`] = { name: me.name, email: me.email, joined: Date.now() };
      if (S.ducks[me.key] == null) ch[`ducks.${me.key}`] = 0;
      update(ch);
    }
    prune();
    if (!m.fromCache && S.jobs['w-recycling']?.note === 'Goes out Monday or Tuesday' && !S.jobs['w-recycling'].days) {
      update({ 'jobs.w-recycling.days': [1, 4], 'jobs.w-recycling.note': DEL });
    }
    render();
  }, (err) => {
    console.error(err);
    if (err.code === 'permission-denied') {
      blocked = true; unsub?.(); unsub = null;
      renderMessage('Not on the list', `${esc(me?.email || 'This account')} isn’t one of the two addresses this house allows. Sign out and use the right account, or add it to the rules (see SETUP.md).`, '<button class="btn dark" data-action="sign-out-now">Sign out</button>');
    } else {
      renderMessage('Can’t open the house', esc(err.message), '<button class="btn dark" data-action="sign-out-now">Sign out</button>');
    }
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  const params = new URLSearchParams(location.search);
  if (!firebaseConfig || params.has('demo')) { store = demoStore(); startData(); return; }
  try { store = await firebaseStore(); }
  catch (e) {
    console.error(e);
    renderMessage('Couldn’t start', 'The app needs signal the very first time it opens on a phone, to download what it needs for offline use. Try again with signal.', '<button class="btn dark" onclick="location.reload()">Try again</button>');
    return;
  }
  store.onAuth((user) => {
    if (!user) { unsub?.(); unsub = null; S = null; me = null; closeCel(); renderSignIn(); return; }
    me = store.me();
    if (!me.verified) {
      return renderMessage('Check your email', `We sent a link to ${esc(me.email)}. Tap it, then come back here.`,
        '<button class="btn dark" data-action="check-verified">I’ve tapped the link</button><button class="btn ghost" data-action="resend">Send it again</button><button class="btn ghost" data-action="sign-out-now">Sign out</button>');
    }
    startData();
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
