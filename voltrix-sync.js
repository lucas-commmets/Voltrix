// Voltrix account, friends, and leaderboard sync.
// Loaded as an ES module (dynamic import) from the hub and every game page.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, addDoc, query, where, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig } from './firebase-init.js';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

const SESSION_KEY = 'voltrix_session';

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanUsername(u) {
  return (u || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
}

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
export function clearSession() { localStorage.removeItem(SESSION_KEY); }
function setSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }

export async function signUp(usernameRaw, pin) {
  const username = cleanUsername(usernameRaw);
  if (!username || username.length < 3) throw new Error('Username needs to be at least 3 characters (letters, numbers, underscore).');
  if (!/^\d{4,6}$/.test(pin)) throw new Error('PIN must be 4-6 digits.');

  const ref = doc(db, 'users', username);
  const existing = await getDoc(ref);
  if (existing.exists()) throw new Error('That username is taken — try another.');

  const pinHash = await sha256(username + ':' + pin);
  await setDoc(ref, {
    pinHash,
    scores: { reflex: 0, tower: 0, dash: 0, dodge: 0, target: 0, blitz: 0 },
    createdAt: serverTimestamp()
  });
  setSession({ username, pinHash });
  return username;
}

export async function logIn(usernameRaw, pin) {
  const username = cleanUsername(usernameRaw);
  const pinHash = await sha256(username + ':' + pin);
  const ref = doc(db, 'users', username);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('No account with that username.');
  if (snap.data().pinHash !== pinHash) throw new Error('Wrong PIN.');
  setSession({ username, pinHash });
  return username;
}

export async function saveScore(game, value) {
  const session = getSession();
  if (!session) return; 

  const gameKey = String(game).trim().toLowerCase();
  const numericValue = Number(value);
  if (isNaN(numericValue)) return;

  try {
    const ref = doc(db, 'users', session.username);
    const snap = await getDoc(ref);
    
    if (!snap.exists()) return;

    const userData = snap.data();
    const currentScore = userData.scores?.[gameKey];

    // Determine if the new score is an improvement
    let isBetter = false;
    if (gameKey === 'reflex') {
      // Lower score is better (ms response time)
      isBetter = currentScore === undefined || currentScore === 0 || numericValue < currentScore;
    } else {
      // Higher score is better (points/blocks/seconds)
      isBetter = currentScore === undefined || numericValue > currentScore;
    }

    if (!isBetter) return;

    // Use setDoc with merge to ensure missing score keys are safely initialized
    await setDoc(ref, {
      pinHash: session.pinHash,
      scores: {
        [gameKey]: numericValue
      }
    }, { merge: true });

  } catch (e) {
    console.error(`[Voltrix Sync] Error saving score for ${gameKey}:`, e);
  }
}

export async function sendFriendRequest(toRaw) {
  const session = getSession();
  if (!session) throw new Error('Log in first.');
  const to = cleanUsername(toRaw);
  if (!to) throw new Error('Enter a username.');
  if (to === session.username) throw new Error("That's your own username.");
  const toSnap = await getDoc(doc(db, 'users', to));
  if (!toSnap.exists()) throw new Error('No user with that username.');

  const existingQ = query(
    collection(db, 'friendRequests'),
    where('from', '==', session.username),
    where('to', '==', to)
  );
  const existingSnap = await getDocs(existingQ);
  if (!existingSnap.empty) throw new Error('You already sent a request to this user.');

  await addDoc(collection(db, 'friendRequests'), {
    from: session.username,
    to,
    status: 'pending',
    createdAt: serverTimestamp()
  });
}

export async function listIncomingRequests() {
  const session = getSession();
  if (!session) return [];
  const q = query(
    collection(db, 'friendRequests'),
    where('to', '==', session.username),
    where('status', '==', 'pending')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function respondToRequest(reqId, accept) {
  const ref = doc(db, 'friendRequests', reqId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  await updateDoc(ref, {
    from: snap.data().from,
    to: snap.data().to,
    status: accept ? 'accepted' : 'rejected'
  });
}

export async function listFriends() {
  const session = getSession();
  if (!session) return [];
  const q1 = query(collection(db, 'friendRequests'), where('from', '==', session.username), where('status', '==', 'accepted'));
  const q2 = query(collection(db, 'friendRequests'), where('to', '==', session.username), where('status', '==', 'accepted'));
  const [s1, s2] = await Promise.all([getDocs(q1), getDocs(q2)]);
  const friends = new Set();
  s1.docs.forEach(d => friends.add(d.data().to));
  s2.docs.forEach(d => friends.add(d.data().from));
  return Array.from(friends);
}

export async function getUserScores(username) {
  const snap = await getDoc(doc(db, 'users', username));
  return snap.exists() ? snap.data().scores : null;
}

export async function getLeaderboard(game) {
  const session = getSession();
  if (!session) return [];
  const friends = await listFriends();
  const usernames = [session.username, ...friends];
  const rows = [];
  for (const u of usernames) {
    const scores = await getUserScores(u);
    rows.push({ username: u, score: scores?.[game] ?? 0, isMe: u === session.username });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}
