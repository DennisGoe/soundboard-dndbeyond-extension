// Soundboard Bridge — Page-Context Hook (MAIN world).
//
// WARUM: Unser ISOLATED-World content.js kann DnD Beyonds interne Roll-Pipeline
// nicht sehen (separater JS-Context). Der 3D-Wuerfel-Roller (Roller-*.js)
// pumpt Ergebnisse durch DnD Beyonds internen "message broker", nicht in den
// Haupt-DOM — DOM-MutationObserver schlagen daher zuverlaessig fehl.
//
// LOESUNG (abgeguckt bei Beyond20 kakaroto/Beyond20, src/dndbeyond/base/message-broker.js):
//   DnD Beyond exportiert seinen Message-Broker als Symbol-Property auf window:
//
//       const mb = window[Symbol.for("@dndbeyond/message-broker-lib")];
//       mb.subscribe((message) => { ... });
//
//   Alle Wurf-Events laufen als message.eventType == "dice/roll/pending|deferred|fulfilled"
//   durch. "fulfilled" traegt das Endergebnis (data.action = Label, data.rolls[].result.total,
//   data.rolls[].result.values, data.rolls[].diceNotationStr = Formel).
//
// Dieses Script laeuft in MAIN world (manifest world:"MAIN"), hooked die
// Subscription und BRIDGED das Event per window.postMessage in die ISOLATED
// world rueber. content.js (dort) hoert, extrahiert und POSTet an das BE.
//
// KOEXISTENZ mit Beyond20: wir rufen NUR mb.subscribe(cb) — kein dispatch-Patching.
// Mehrere Subscriber sind erlaubt; Beyond20 bleibt funktionsfaehig.
//
// FALLBACK (nicht implementiert): wenn DnD Beyond den Symbol-Export mal entfernt,
// Alternative = DnD Beyond GameLog-Websocket (wss://gamelog-service...) direkt
// abhoeren, Auth via Cobalt-Token aus Cookies.

(() => {
    if (window.__soundboardDdbHookInstalled__) {
        console.debug("[Soundboard DDB] page-hook: schon installiert, skip.");
        return;
    }
    window.__soundboardDdbHookInstalled__ = true;

    const BRIDGE_FLAG = "__sb_ddb_dice_bridge__";
    const BROKER_SYMBOL_KEY = Symbol.for("@dndbeyond/message-broker-lib");

    console.debug("[Soundboard DDB] page-hook: boot (MAIN world).");

    function tryInstall() {
        try {
            const mb = window[BROKER_SYMBOL_KEY];
            if (!mb || typeof mb.subscribe !== "function") return false;

            // Doppelt-Subscribe verhindern: wir legen unsere Callback-Referenz
            // auf den Broker, damit wir sie bei einem spaeteren Re-Register nicht
            // dupliziert abonnieren.
            if (mb.__sbSubscriberInstalled__) return true;
            mb.__sbSubscriberInstalled__ = true;

            mb.subscribe((message) => {
                try {
                    if (!message || typeof message.eventType !== "string") return;
                    // Interessant sind alle dice/roll/*-Events. Wir lassen das
                    // Routing/Filtering (nur fulfilled an BE senden) ins content.js,
                    // damit der Hook moeglichst "dumm" + log-freudig bleibt.
                    if (!message.eventType.startsWith("dice/roll/")) return;

                    // Struktur-Clone (vermeidet Referenz-Leaks + Firefox-Clone-Issues).
                    let safe;
                    try {
                        safe = JSON.parse(JSON.stringify(message));
                    } catch (e) {
                        safe = {
                            id: message.id,
                            eventType: message.eventType,
                            dateTime: message.dateTime,
                            userId: message.userId,
                            source: message.source,
                            data: message.data,
                        };
                    }
                    console.debug(
                        "[Soundboard DDB] page-hook: dice event",
                        message.eventType,
                        "-> bridge",
                    );
                    window.postMessage({ [BRIDGE_FLAG]: true, message: safe }, "*");
                } catch (e) {
                    console.warn("[Soundboard DDB] page-hook: subscriber threw", e);
                }
            });

            console.debug(
                "[Soundboard DDB] page-hook: subscribed to DDB message-broker-lib ✓",
            );
            return true;
        } catch (e) {
            console.warn("[Soundboard DDB] page-hook: install attempt failed", e);
            return false;
        }
    }

    // Der Broker wird erst nach DnD-Beyond-App-Bootstrap gesetzt. Wir retrien
    // bis zu ~30 Sekunden alle 200 ms. Das deckt SPA-Navigation + Lazy-Load des
    // Roll-Moduls ab, ohne dauerhaft zu busy-wait'en.
    if (tryInstall()) return;

    let tries = 0;
    const maxTries = 150;
    const iv = setInterval(() => {
        tries++;
        if (tryInstall()) {
            clearInterval(iv);
            console.debug(
                `[Soundboard DDB] page-hook: installed after ${tries * 200} ms.`,
            );
            return;
        }
        if (tries >= maxTries) {
            clearInterval(iv);
            console.warn(
                "[Soundboard DDB] page-hook: message-broker-lib NIE erschienen nach 30 s —" +
                    " DnD Beyond koennte den Symbol-Export umgebaut haben. Fallback: GameLog-WS.",
            );
        }
    }, 200);
})();
