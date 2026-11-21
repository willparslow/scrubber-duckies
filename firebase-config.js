// Paste your Firebase web app config here (see SETUP.md, step 2).
// While this is null the app runs in demo mode: saved on one phone only, no syncing.
//
// Example:
// export const firebaseConfig = {
//   apiKey: "AIza...",
//   authDomain: "scrubber-duckies-12345.firebaseapp.com",
//   projectId: "scrubber-duckies-12345",
//   storageBucket: "scrubber-duckies-12345.firebasestorage.app",
//   messagingSenderId: "1234567890",
//   appId: "1:1234567890:web:abc123"
// };
export const firebaseConfig = {
  apiKey: "AIzaSyCntkcVY39kzrQvW5Z1UrLAUyc7-1wYIDI",
  authDomain: "scrubber-duckies.firebaseapp.com",
  projectId: "scrubber-duckies",
  storageBucket: "scrubber-duckies.firebasestorage.app",
  messagingSenderId: "218531507425",
  appId: "1:218531507425:web:9f8b5270f528d82014dba0"
};

// Push notifications: Firebase console → Project settings → Cloud Messaging → Web Push certificates →
// the "Key pair" (a long string starting with B). Leave as null to keep notifications switched off.
export const vapidKey = "BEhiuxpTFdYnsGjfkxV28YMR7yA891DMBk37xJtWygYFZoCOSD3_9WaIOC1AhHiNk2DPLTLDZCjRTqXQMP785bs";

// Firebase library version loaded from Google's CDN (cached for offline use by sw.js)
export const FIREBASE_VERSION = '10.14.1';
