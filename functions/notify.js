// Works out which notifications a change to a house should send.
// Pure (no Firebase calls) so it can be tested on its own.

const LEVELS = [
  { at: 0, name: 'Duckling' }, { at: 25, name: 'Puddle Paddler' }, { at: 75, name: 'Pond Patroller' },
  { at: 150, name: 'Bath Baron' }, { at: 300, name: 'Admiral of Suds' }, { at: 600, name: 'Grand Quackmaster' },
  { at: 1000, name: 'Legend of the Lather' },
];
const levelOf = (n) => LEVELS.filter((l) => n >= l.at).at(-1);
const total = (ducks) => Object.values(ducks || {}).reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'Someone';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const duckies = (n) => `+${n} ${n === 1 ? 'duckie' : 'duckies'}`;

// Jobs done while a phone was offline sync later; don't announce anything older than this.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * @returns {Array<{to: 'others'|'everyone', exceptKey?: string, type: 'jobs'|'oneoffs'|'levels'|'ducks', title: string, body: string, tag: string}>}
 */
function notificationsFor(before, after, now = Date.now()) {
  if (!before || !after) return [];
  const out = [];
  const house = after.name || 'Your house';
  const nameOf = (key) => firstName(after.members?.[key]?.name || before.members?.[key]?.name);
  const jobName = (e) => after.jobs?.[e.job]?.name || e.name || 'a job';

  // Jobs ticked off
  const fresh = Object.entries(after.log || {})
    .filter(([id, e]) => !(before.log || {})[id] && e && now - (e.at || 0) < MAX_AGE_MS)
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => a.at - b.at);
  const newlyUnlocked = Object.keys(after.unlocked || {}).filter((k) => !(before.unlocked || {})[k]);
  for (const e of fresh) {
    const who = nameOf(e.by);
    const job = after.jobs?.[e.job];
    if (job?.freq === 'monthly' && e.unlocks && newlyUnlocked.includes(e.job) && job.duck?.name) {
      out.push({ to: 'others', exceptKey: e.by, type: 'ducks', tag: `entry-${e.id}`,
        title: `🎆 ${who} unlocked a rare duck: ${job.duck.name}!`, body: `${jobName(e)} · ${duckies(e.pts || 0)}` });
    } else if (e.sweep) {
      out.push({ to: 'others', exceptKey: e.by, type: 'jobs', tag: `entry-${e.id}`,
        title: `🧹 ${who} got a Clean Sweep!`, body: `${jobName(e)} was the last daily job · ${duckies(e.pts || 0)}` });
    } else {
      out.push({ to: 'others', exceptKey: e.by, type: 'jobs', tag: `entry-${e.id}`,
        title: `🦆 ${who} did ${jobName(e)}`, body: `${duckies(e.pts || 0)} · ${house} has ${plural(total(after.ducks), 'duckie')}` });
    }
  }

  // One-off jobs added
  for (const [id, j] of Object.entries(after.jobs || {})) {
    if (j?.freq !== 'oneoff' || (before.jobs || {})[id]) continue;
    if (now - (j.created || 0) > MAX_AGE_MS) continue;
    out.push({ to: 'others', exceptKey: j.by, type: 'oneoffs', tag: `oneoff-${id}`,
      title: `📝 ${nameOf(j.by)} added a one-off job`, body: `${j.name} · ${duckies(Number(j.pts) || 2)} for whoever does it` });
  }

  // Level up (everyone, including whoever did it: it's a moment for the house)
  const lb = levelOf(total(before.ducks)), la = levelOf(total(after.ducks));
  if (la.at > lb.at) {
    const by = fresh.length ? nameOf(fresh.at(-1).by) : null;
    out.push({ to: 'everyone', type: 'levels', tag: `level-${la.name}`,
      title: `🏆 Level up! ${house} is now ${la.name}`, body: `${plural(total(after.ducks), 'duckie')} in the pond${by ? ` · the winning duckie came from ${by}` : ''}` });
  }
  return out;
}

module.exports = { notificationsFor, levelOf, LEVELS };
