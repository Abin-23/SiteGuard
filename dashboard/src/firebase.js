
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyD5pRlHEc1LC13OhvjHsg5osLcn2J4jQ-g",
  authDomain: "siteguard-e6767.firebaseapp.com",
  projectId: "siteguard-e6767",
  storageBucket: "siteguard-e6767.firebasestorage.app",
  messagingSenderId: "977356328051",
  appId: "1:977356328051:web:a378ec91dd1cd491f5ae06",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
