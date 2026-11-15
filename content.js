// Soundboard Bridge — Content Script (ISOLATED world)
//
// Laeuft auf https://www.dndbeyond.com/characters/<id>.
// Zieht charId aus der URL, poll't character-service.dndbeyond.com alle ~4 s
// (mit credentials:"include", nutzt also die Session des eingeloggten Nutzers),
// diffed, und POSTet nur Aenderungen an das Soundboard-Backend.
//
// Wuerfel: wird NICHT mehr per DOM-MutationObserver erfasst (sackgasse — DnD
// Beyonds 3D-Roller laeuft in einem separaten JS-Chunk und schreibt die
// Ergebnisse durch den internen message-broker-lib, nicht in den Haupt-DOM).
// Stattdessen hoert dieses content.js auf `window.postMessage`-Events, die
// das Companion-Script `page-hook.js` (MAIN world) aus DnD Beyonds message
// broker heruebergibt.
//
// PONYTAIL — Fragilitaet:
//  - Das character-service-Schema ist offiziell undokumentiert; falls DnD Beyond
//    das umbaut, muss extractState() angepasst werden.
//  - Der Page-Hook fasst `window[Symbol.for("@dndbeyond/message-broker-lib")]`
//    an — ein internes Export-Detail. Wenn DnD Beyond das umbenennt, muss der
//    Hook (page-hook.js) angepasst werden.
//
// FALLBACK (nicht implementiert): statt page-hook direkt den DnD-Beyond-
// GameLog-Websocket mit Cobalt-Token aus Cookies abhoeren — stabileres Signal,
// aber aufwendiger (Auth-Handshake).

(() => {
    const POLL_INTERVAL_MS = 4000;
    const DEFAULT_BACKEND = "http://localhost:8000";
    const BRIDGE_FLAG = "__sb_ddb_dice_bridge__";

    // --- State ---
    let lastSyncedState = {
        hp: null,     // JSON-String zum Diff
        ac: null,
        conditions: null,
        inventory: null,
    };
    let pollTimer = null;
    let charId = null;

    // Dice-Dedupe: der Broker kann denselben "fulfilled"-Event mehrfach
    // zustellen (einmal pro Subscriber-Pass, einmal beim Re-Dispatch). Wir
    // mappen auf message.id und werfen Doubletten weg.
    const seenDiceIds = new Set();
    const seenDiceIdsMax = 200;

    function log(...args) { console.log("[Soundboard DDB]", ...args); }
    function warn(...args) { console.warn("[Soundboard DDB]", ...args); }
    function dbg(...args) { console.debug("[Soundboard DDB]", ...args); }

    function getCharIdFromUrl() {
        const m = location.pathname.match(/\/characters\/(\d+)/);
        return m ? m[1] : null;
    }

    async function getStoredAuth() {
        return new Promise((res) => {
            chrome.storage.local.get(["jwt", "backendUrl"], (data) => {
                res({
                    jwt: data?.jwt || null,
                    backend: (data?.backendUrl || DEFAULT_BACKEND).replace(/\/+$/, ""),
                });
            });
        });
    }

    async function fetchCharacter(id) {
        const url = `https://character-service.dndbeyond.com/character/v5/character/${id}`;
        const resp = await fetch(url, { credentials: "include" });
        if (!resp.ok) throw new Error(`character-service HTTP ${resp.status}`);
        return resp.json();
    }

    // Normalisiert DDB-Char-Payload auf unser Shape.
    // DDB-Shape ist tief verschachtelt; wir ziehen nur das, was wir brauchen.
    function extractState(payload) {
        const d = payload?.data || payload || {};

        const base = Number(d.baseHitPoints);
        const bonus = Number(d.bonusHitPoints || 0);
        const removed = Number(d.removedHitPoints || 0);
        const temp = Number(d.temporaryHitPoints || 0);
        let hp = undefined;
        if (Number.isFinite(base)) {
            const max = base + (Number.isFinite(bonus) ? bonus : 0);
            const current = max - (Number.isFinite(removed) ? removed : 0);
            hp = { current, max };
            if (Number.isFinite(temp) && temp > 0) hp.temp = temp;
        }

        let ac = undefined;
        const acCandidates = [d.overrideArmorClass, d.armorClass, d.ac];
        for (const c of acCandidates) {
            const n = Number(c);
            if (Number.isFinite(n) && n > 0) { ac = n; break; }
        }

        let conditions = undefined;
        if (Array.isArray(d.conditions)) {
            conditions = d.conditions.map((c) => {
                return c?.definition?.name || c?.name || null;
            }).filter((x) => typeof x === "string" && x.length > 0);
        }

        let inventory = undefined;
        if (Array.isArray(d.inventory)) {
            inventory = d.inventory.slice(0, 500).map((it) => {
                const def = it?.definition || {};
                return {
                    name: def.name || it?.name || "Unbenannt",
                    qty: Number.isFinite(+it?.quantity) ? +it.quantity : 1,
                    type: def.filterType || def.type || undefined,
                    equipped: !!it?.equipped,
                    description: def.description
                        ? String(def.description).replace(/<[^>]+>/g, "").slice(0, 400)
                        : undefined,
                };
            });
        }

        return { hp, ac, conditions, inventory };
    }

    function diff(newState) {
        const out = {};
        for (const key of ["hp", "ac", "conditions", "inventory"]) {
            const nv = newState[key];
            if (nv === undefined) continue;
            const serialized = JSON.stringify(nv);
            if (serialized !== lastSyncedState[key]) {
                out[key] = nv;
                lastSyncedState[key] = serialized;
            }
        }
        return out;
    }

    async function sendSync(patch, diceRoll) {
        const { jwt, backend } = await getStoredAuth();
        if (!jwt) {
            warn("Nicht eingeloggt — Sync uebersprungen.");
            return;
        }
        const body = { ...patch };
        if (diceRoll) body.diceRoll = diceRoll;
        if (Object.keys(body).length === 0) return;
        try {
            const resp = await fetch(backend + "/api/dndbeyond/sync", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + jwt,
                },
                body: JSON.stringify(body),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                warn("Sync-Fehler:", resp.status, err);
            } else {
                const r = await resp.json().catch(() => ({}));
                log("Sync OK", Object.keys(body), "→", r.campaigns || []);
            }
        } catch (e) {
            warn("Sync-POST exception:", e);
        }
    }

    async function pollOnce() {
        try {
            if (!charId) {
                charId = getCharIdFromUrl();
                if (!charId) return;
            }
            const payload = await fetchCharacter(charId);
            const state = extractState(payload);
            const patch = diff(state);
            if (Object.keys(patch).length > 0) {
                await sendSync(patch, null);
            }
        } catch (e) {
            warn("poll error:", e?.message || e);
        }
    }

    function startPolling() {
        stopPolling();
        pollOnce();
        pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
    }
    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // --- Dice-Bridge: Page-Context -> content.js ---
    //
    // page-hook.js (MAIN world) subscribed sich bei DnD Beyonds message broker
    // und forwarded jedes dice/roll/* via window.postMessage({__sb_ddb_dice_bridge__:
    // true, message: {...}}). Wir hoeren hier.

    function extractDiceRollFromBrokerMsg(brokerMsg) {
        // Shape (reverse engineered aus Beyond20):
        //   brokerMsg.eventType = "dice/roll/fulfilled"
        //   brokerMsg.data = {
        //     action?: string,              // Label, z.B. "Initiative", "Strength Check"
        //     context?: { name?, ... },
        //     rollId?: string,
        //     rolls: [{
        //       diceNotationStr?: string,   // Formel "1d20+5"
        //       rollType?: string,          // "to hit" | "damage" | "check" | ...
        //       rollKind?: string,          // "advantage" | "disadvantage" | ""
        //       result: {
        //         total: number,
        //         constant?: number,
        //         values?: number[],        // Einzelwuerfe
        //         text?: string,
        //       }
        //     }]
        //   }
        if (!brokerMsg || typeof brokerMsg !== "object") return null;
        const data = brokerMsg.data || {};
        const rolls = Array.isArray(data.rolls) ? data.rolls : [];
        if (rolls.length === 0) return null;

        // Erster Roll ist der Haupt-Wurf (bei Multi-Teil-Attacken gibt es mehrere;
        // wir reichen zunaechst nur den ersten weiter — reicht fuer den Chat-Toast
        // im Spielbrett).
        const r0 = rolls[0] || {};
        const res = r0.result || {};
        const total = Number(res.total);
        if (!Number.isFinite(total)) {
            // Manche Events haben noch kein result (pending/deferred). Ignorieren.
            return null;
        }

        const label =
            (typeof data.action === "string" && data.action.trim()) ||
            (typeof r0.rollType === "string" && r0.rollType) ||
            "Wurf";

        const formula =
            (typeof r0.diceNotationStr === "string" && r0.diceNotationStr) ||
            undefined;

        const rollsList = Array.isArray(res.values)
            ? res.values.map((n) => Number(n)).filter((n) => Number.isFinite(n))
            : undefined;

        return {
            label: String(label).slice(0, 80),
            formula,
            total: Math.round(total),
            rolls: rollsList && rollsList.length ? rollsList : undefined,
            timestamp: new Date().toISOString(),
        };
    }

    function rememberDiceId(id) {
        if (!id) return false;
        if (seenDiceIds.has(id)) return true;
        seenDiceIds.add(id);
        // Groesse begrenzen (einfachster FIFO).
        if (seenDiceIds.size > seenDiceIdsMax) {
            const first = seenDiceIds.values().next().value;
            if (first) seenDiceIds.delete(first);
        }
        return false;
    }

    function installBridge() {
        window.addEventListener("message", (ev) => {
            // Nur same-window + unser Flag.
            if (ev.source !== window) return;
            const d = ev.data;
            if (!d || typeof d !== "object" || d[BRIDGE_FLAG] !== true) return;

            const msg = d.message;
            if (!msg) return;
            dbg("bridge-in:", msg.eventType, msg.id);

            // Nur "fulfilled" liefert ein Ergebnis. pending/deferred ignorieren.
            if (msg.eventType !== "dice/roll/fulfilled") return;

            // Dedupe.
            if (rememberDiceId(msg.id)) {
                dbg("dup dice id, skip:", msg.id);
                return;
            }

            const roll = extractDiceRollFromBrokerMsg(msg);
            if (!roll) {
                dbg("kein result im fulfilled-event, skip.");
                return;
            }
            log("Wurf erkannt:", roll);
            sendSync({}, roll);
        }, false);
        dbg("bridge installed (listening for window.postMessage).");
    }

    // --- Lifecycle ---

    function boot() {
        charId = getCharIdFromUrl();
        if (!charId) {
            log("Keine charId in URL — Bridge inaktiv.");
            // Bridge trotzdem installieren: SPA-Navigation koennte uns spaeter
            // auf eine Charakterseite bringen; dort greift startPolling dann via
            // URL-Watcher. Der Dice-Bridge-Listener schadet nicht.
        }
        log("Content-Script aktiv. charId =", charId);
        installBridge();
        if (charId) startPolling();

        // DnD Beyond ist eine SPA — URL-Wechsel ohne Full-Reload erkennen.
        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                const nid = getCharIdFromUrl();
                if (nid !== charId) {
                    charId = nid;
                    lastSyncedState = { hp: null, ac: null, conditions: null, inventory: null };
                    if (nid) {
                        log("Char gewechselt →", nid);
                        startPolling();
                    } else {
                        stopPolling();
                    }
                }
            }
        }, 1000);
    }

    boot();
})();
