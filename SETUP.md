# Scrubber Duckies: setup guide

> **Sharing with other people.** Each house is private. To let someone start their own house, go to **Pond → Admin → Make a new invite code** and send them the code with the app's link. They sign in, tap **Set up a house**, enter the code and choose to start with a ready-made job list or an empty one. To add someone to *your* house instead, go to **Pond → Your house → Invite** and enter their Gmail address. **Pond → Admin → Share my jobs as the starter list** makes your current jobs (and duckie scores) the ready-made list for new houses.


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
5. **Lock it down:** in Firestore, open the **Rules** tab. Paste in the contents of `firestore.rules`, replace `ADMIN_EMAIL` with your Gmail address and `LEGACY_EMAIL_1` and `LEGACY_EMAIL_2` with yours and Tessa's (all lower case, keep the quotes), then click **Publish**.

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
2. Tap **Continue with Google** and pick the Gmail address you put in the rules. You (the admin) tap **Set up a house**. Then invite your partner from **Pond → Your house**; they sign in and tap **Join**.
3. **Add it to the home screen:**
   - **iPhone (Safari):** tap Share → *Add to Home Screen*.
   - **Android (Chrome):** tap ⋮ → *Install app* (or *Add to Home screen*).
4. Open it once from the home screen icon. From then on it opens and works with no signal.



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

---

## Push notifications (optional, about 20 minutes once)

Notifications are sent by a small Cloud Function (the `functions` folder), which runs in your Firebase project whenever a house changes.

### On your phone or computer
1. **Switch to the pay-as-you-go plan.** In the Firebase console, tap **Upgrade** (bottom of the menu, next to "Spark") and choose **Blaze**, then add a card. Light use like this stays inside the free allowance. Set a **budget alert** (for example £1) when it offers, so you'd hear about any charge.
2. **Make the notification key.** Go to **Project settings → Cloud Messaging → Web Push certificates → Generate key pair**. Copy the long key it shows (it starts with **B**) and put it in `firebase-config.js` as `vapidKey` (or send it to Claude).
3. **Update the database rules** with the latest `firestore.rules` (fill in the emails as before) and tap **Publish**.

### Deploy the function (once, plus again whenever `functions/` changes)
You can do this on a computer, or in **Google Cloud Shell** (https://shell.cloud.google.com), which runs in any browser, phone included. Sign in with the same Google account as Firebase.

```
npm install -g firebase-tools
firebase login --no-localhost
git clone https://github.com/willparslow/scrubber-duckies.git
cd scrubber-duckies/functions && npm install && cd ..
firebase deploy --only functions
```

- `firebase login --no-localhost` gives you a link. Open it, sign in, then paste the code it shows back into the terminal.
- The first deploy switches on a few Google Cloud services, which takes a few minutes. If it asks about a **cleanup policy** for container images, press Enter to accept the default.
- If it says the **region** doesn't match your database, change `REGION` at the top of `functions/index.js` (`eur3` → `europe-west1`, `nam5` → `us-central1`) and deploy again.

### Then on each phone
Open the app **from the home-screen icon** (iPhones only allow notifications there), then go to **Pond → Notifications → Turn on notifications** and tap **Allow**. Use **Show a test notification** to check. Each phone chooses what it wants to hear about.
