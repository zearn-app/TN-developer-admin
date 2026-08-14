// ============================================================
// This admin panel connects to the SAME Firebase project as the public
// tn-developer site, so any website/app you add here shows up live there.
//
// ONE-TIME SETUP (see README.md for full details):
// 1. Firebase Console → Authentication → Sign-in method → enable "Email/Password"
// 2. Firebase Console → Authentication → Users → Add user (your admin login)
// 3. Copy that user's UID and paste it into ADMIN_UID below
// 4. Paste the Firestore rules from the main site's firebase-config.js
//    (replacing ADMIN_UID there too) into Firestore → Rules
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  writeBatch,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAas0AftCAV9eIddoEVezhjVsCAMIXlcUY",
  authDomain: "tn-developer-54557.firebaseapp.com",
  projectId: "tn-developer-54557",
  storageBucket: "tn-developer-54557.firebasestorage.app",
  messagingSenderId: "780758782991",
  appId: "1:780758782991:web:8de4806f8d7eea970fbf7a",
  measurementId: "G-Q8EYMHQKKL"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Expose a small API on window that admin.js (a plain script) uses, so we
// don't have to juggle two module files.
window.ADMIN = {
  auth,

  login(email, password) {
    return signInWithEmailAndPassword(auth, email, password);
  },
  logout() {
    return signOut(auth);
  },
  onAuth(cb) {
    return onAuthStateChanged(auth, cb);
  },

  // ---- generic collection helpers ----
  watchCollection(name, orderField, cb, dir = "asc") {
    const q = query(collection(db, name), orderBy(orderField, dir));
    return onSnapshot(q, (snap) => {
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, (err) => console.error(`watchCollection(${name}) error:`, err));
  },
  watchDoc(collectionName, docId, cb) {
    // used for analytics/pageViews and analytics/appDownloads
    return onSnapshot(doc(db, collectionName, docId), (snap) => {
      cb(snap.exists() ? snap.data() : {});
    }, (err) => console.error(`watchDoc(${collectionName}/${docId}) error:`, err));
  },
  add(name, data) {
    return addDoc(collection(db, name), data);
  },
  update(name, id, data) {
    return updateDoc(doc(db, name, id), data);
  },
  remove(name, id) {
    return deleteDoc(doc(db, name, id));
  },

  // ---- app version history (apps/{appId}/versions/{versionId}) ----
  watchVersions(appId, cb) {
    const q = query(collection(db, "apps", appId, "versions"), orderBy("releaseDate", "desc"));
    return onSnapshot(q, (snap) => {
      cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, (err) => console.error(`watchVersions(${appId}) error:`, err));
  },
  addVersion(appId, data) {
    return addDoc(collection(db, "apps", appId, "versions"), data);
  },
  updateVersion(appId, versionId, data) {
    return updateDoc(doc(db, "apps", appId, "versions", versionId), data);
  },
  removeVersion(appId, versionId) {
    return deleteDoc(doc(db, "apps", appId, "versions", versionId));
  },
  // Marks exactly one version as visible on the live site — flips every
  // other version for this app to visible:false in the same batch, so only
  // one can ever be "live" at a time.
  async setVisibleVersion(appId, versionId) {
    const snap = await getDocs(collection(db, "apps", appId, "versions"));
    const batch = writeBatch(db);
    snap.docs.forEach(d => {
      batch.update(d.ref, { visible: d.id === versionId });
    });
    return batch.commit();
  },
};

window.dispatchEvent(new Event("admin-firebase-ready"));
