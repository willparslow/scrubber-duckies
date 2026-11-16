# Scrubber Duckies: setup guide

About 20 minutes, all free, done once. It's the same recipe as the Meal Planner.

The app comes in two parts:
- **The app itself**: these files, hosted on GitHub Pages.
- **Your shared data**: stored in Firebase (Google). It syncs between both phones and keeps a copy on each phone, so it works with no signal.

Until step 2 is done, the app runs in **demo mode**: everything works, but it only saves on one phone. You can try it straight away: open `index.html` through any web server and add `?demo` to the address.

---

## 1. Create the Firebase project (about 8 min)

1. Go to <https://console.firebase.google.com> and sign in with your Google account.
2. **Create a project.** Call it something like `scrubber-duckies`. You can switch off Google Analytics.
   (Use a new project rather than the meal planner's one: its security rules would be replaced by these.)
3. **Turn on sign-in:** go to *Build → Authentication → Get started → Sign-in method*. Choose **Google**, switch it on, pick your support email and save. Then *Add new provider → Email/Password*, switch it on and save. Email/password is a backup in case Google sign-in misbehaves inside the home-screen app.
4. **Create the database:** go to *Build → Firestore Database → Create database*.
   - Location: choose **europe-west2 (London)**.
   - Start in **production mode**.
5. **Lock it down:** in Firestore, open the **Rules** tab. Paste in the contents of `firestore.rules`, replace `WILL_EMAIL` and `TESSA_EMAIL` with your two Gmail addresses (all lower case, keep the quotes), then click **Publish**.

## 2. Get the app's Firebase config (about 2 min)

1. In Firebase, go to *Project settings* (the cog icon) → *Your apps* and click the **</>** (Web) icon.
2. Name it `scrubber-duckies`. You **don't** need Firebase Hosting, so leave that unticked.
3. Firebase shows a `firebaseConfig = { ... }` block. Copy it into `firebase-config.js`, in place of `null`:

```js
export const firebaseConfig = {
  apiKey: "…",
  authDomain: "…",
  projectId: "…",
  storageBucket: "…",
  messagingSenderId: "…",
  appId: "…"
};
```

These values are safe to put on a public website. What keeps your data private is the rules from step 1.5.

## 3. Put it on GitHub Pages (about 5 min)

1. On GitHub, create a new repository called `scrubber-duckies` (public is simplest: Pages on a private repo needs a paid plan).
2. Upload **all the files in this folder**, including the `icons` folder, to the repo's main branch.
3. Go to *Settings → Pages*. Under *Source*, choose **Deploy from a branch**, pick **main** and **/ (root)**, then click Save.
4. After about a minute the app will be at `https://willparslow.github.io/scrubber-duckies/`.
5. Back in Firebase, go to *Authentication → Settings → Authorised domains* and add `willparslow.github.io`.

## 4. Set up each phone (about 2 min each)

1. Open the link on the phone **while you have signal**.
2. Tap **Continue with Google** and pick the Gmail address you put in the rules. The first of you to sign in sets the house up with the full job list; the second joins it automatically.
3. **Add it to the home screen:**
   - **iPhone (Safari):** tap Share → *Add to Home Screen*.
   - **Android (Chrome):** tap ⋮ → *Install app* (or *Add to Home screen*).
4. Open it once from the home screen icon. From then on it opens and works with no signal.

If you see **"Not on the list"**, that account's email isn't in the rules: sign out and pick the other account, or fix the address in the rules.

---

## How it works

- **Today:** the daily jobs, plus anything weekly or fortnightly still to do. Tap a job to tick it off. Tap a ticked job to undo it.
- **Week:** weekly jobs (they reset every Monday) and fortnightly jobs (they show how many days until they're due again).
- **Monthly:** how long since each check was last done. Green up to 30 days, amber to 45, red after that.
- **Pond:** your household level, each person's duckies, the rare duck collection, what's been done recently, and settings.

### Duckies
| Job | Starting duckies | Celebration |
|---|---|---|
| Daily | +1 | A little splash card with bubbles |
| Weekly | +3 | Bubble party with three ducks and confetti |
| Fortnightly | +5 | The Golden Duck, with sunbeams and a confetti shower |
| Monthly | +10 (+20 if more than 45 days) | Fireworks and a rare duck for that job |
| All 8 dailies done | +5 bonus | Clean Sweep bubble party |
| New household level | | Always a big celebration |

When the other person ticks something off, a little note pops up on your phone.

### One-off jobs
On the Today tab, tap **+ Add** next to One-offs, type the job and set its duckies (2 to start with). It stays at the top of Today until one of you ticks it off, shows as done for the rest of that day, then drops off. It still appears under Recently done on the Pond tab.

### Managing the jobs
*Pond → Manage jobs.* Each job has its own duckie score: use − and + to make a job worth more or less (the table above shows the starting amounts). Rename by typing over a name, change how often a job happens with the menu next to it, remove with the bin button, or add a new job at the bottom. Weekly jobs can be set to particular days (the recycling is Mondays and Thursdays): each of those days then needs ticking off, with a reminder the evening before. New monthly jobs get their own rare duck.

### No signal?
Everything still works and is saved on the phone. The badge at the top shows **Offline · saved on phone**. When signal comes back it syncs and shows **Synced ✓**. Both of you ticking things at the same time never clashes: each job done is saved separately.

### Updating the app later
If the app files change, upload them to GitHub and change `VERSION` at the top of `sw.js` (e.g. `v1` → `v2`). Phones pick up the new version next time the app is opened with signal and show an **Update ready** banner.

### Backups
*Pond → Download a backup* saves everything as a file. History older than 120 days is tidied away automatically (the last time each job was done is always kept).
