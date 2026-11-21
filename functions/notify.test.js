const assert = require('assert');
const { notificationsFor } = require('./notify');
const now = Date.now();
const base = {
  name: 'The Parslows', memberEmails: ['w@x', 't@x'],
  members: { w: { name: 'Will' }, t: { name: 'Tessa Parslow' } },
  jobs: { d1: { name: 'Dishwasher', freq: 'daily' }, m1: { name: 'Clean fridge', freq: 'monthly', duck: { name: 'Frosty Quackers' } } },
  log: {}, ducks: { w: 70, t: 3 }, unlocked: {},
};
const clone = (o) => JSON.parse(JSON.stringify(o));
// Tessa ticks dishwasher, pushing the house over 75 (level up)
let after = clone(base); after.log.e1 = { job: 'd1', by: 't', at: now, pts: 2 }; after.ducks.t = 5;
let n = notificationsFor(base, after, now);
assert.equal(n.length, 2); assert.equal(n[0].title, '🦆 Tessa did Dishwasher'); assert.equal(n[0].exceptKey, 't');
assert.equal(n[1].type, 'levels'); assert.match(n[1].title, /Pond Patroller/);
// Rare duck unlock
after = clone(base); after.log.e2 = { job: 'm1', by: 'w', at: now, pts: 10, unlocks: true }; after.unlocked.m1 = true;
n = notificationsFor(base, after, now); assert.equal(n[0].type, 'ducks'); assert.match(n[0].title, /Frosty Quackers/);
// One-off added
after = clone(base); after.jobs.o1 = { name: 'Return parcel', freq: 'oneoff', pts: 2, by: 't', created: now };
n = notificationsFor(base, after, now); assert.equal(n.length, 1); assert.equal(n[0].type, 'oneoffs');
// Old offline entry ignored; undo (deletion) and renames produce nothing
after = clone(base); after.log.e3 = { job: 'd1', by: 't', at: now - 7 * 3600e3, pts: 1 };
assert.equal(notificationsFor(base, after, now).length, 0);
const withEntry = clone(base); withEntry.log.e1 = { job: 'd1', by: 't', at: now, pts: 1 };
assert.equal(notificationsFor(withEntry, base, now).length, 0);
after = clone(base); after.name = 'New name'; assert.equal(notificationsFor(base, after, now).length, 0);
console.log('notify tests passed');
