import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyA_h36fA_bjB9dA35_FWpcO15fsdMOXr4M",
  authDomain: "aschat-10454.firebaseapp.com",
  databaseURL: "https://aschat-10454-default-rtdb.firebaseio.com",
  projectId: "aschat-10454",
  storageBucket: "aschat-10454.firebasestorage.app",
  messagingSenderId: "1000988226480",
  appId: "1:1000988226480:web:24ef431489b19037e49c75"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const googleProvider = new GoogleAuthProvider();

export { auth, db, googleProvider };

