// Soundboard Bridge — Popup
//
// Login speichert JWT + Backend-URL + Username in chrome.storage.local.
// Der Content-Script auf dndbeyond.com liest das daraus und pusht Sync-POSTs.

const $ = (id) => document.getElementById(id);

const DEFAULT_BACKEND = "http://localhost:8000";

async function getState() {
    return new Promise((res) => {
        chrome.storage.local.get(["jwt", "backendUrl", "username"], (data) => res(data || {}));
    });
}
async function setState(patch) {
    return new Promise((res) => chrome.storage.local.set(patch, res));
}
async function clearState() {
    return new Promise((res) => chrome.storage.local.remove(["jwt", "backendUrl", "username"], res));
}

function showLoggedIn(state) {
    $("status-sec").hidden = false;
    $("login-sec").hidden = true;
    $("status").textContent = "angemeldet";
    $("status").className = "ok";
    $("backend-url-display").textContent = state.backendUrl || DEFAULT_BACKEND;
    $("username-display").textContent = state.username || "—";
}

function showLoggedOut() {
    $("status-sec").hidden = true;
    $("login-sec").hidden = false;
    $("status").textContent = "nicht angemeldet";
    $("status").className = "off";
}

async function doLogin() {
    $("login-err").hidden = true;
    const backend = ($("backend").value || DEFAULT_BACKEND).trim().replace(/\/+$/, "");
    const username = ($("username").value || "").trim();
    const password = $("password").value || "";
    if (!username || !password) {
        $("login-err").textContent = "Bitte Username + Passwort angeben.";
        $("login-err").hidden = false;
        return;
    }
    try {
        const resp = await fetch(backend + "/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            throw new Error(body?.msg || `HTTP ${resp.status}`);
        }
        const body = await resp.json();
        if (!body?.token) throw new Error("Kein Token in Antwort");
        await setState({ jwt: body.token, backendUrl: backend, username });
        showLoggedIn({ backendUrl: backend, username });
    } catch (e) {
        $("login-err").textContent = "Login fehlgeschlagen: " + (e?.message || e);
        $("login-err").hidden = false;
    }
}

async function init() {
    const state = await getState();
    if (state.jwt) {
        showLoggedIn(state);
    } else {
        showLoggedOut();
    }
    $("login-btn").addEventListener("click", doLogin);
    $("password").addEventListener("keydown", (e) => {
        if (e.key === "Enter") doLogin();
    });
    $("logout-btn").addEventListener("click", async () => {
        await clearState();
        showLoggedOut();
    });
}

init();
