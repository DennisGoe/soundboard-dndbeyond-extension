# Soundboard Bridge — DnD Beyond

Chrome-Extension (Manifest V3) die Charakter-Daten von DnD Beyond live aufs Soundboard-Spielbrett spiegelt.

Richtung: **nur** DnD Beyond → Soundboard. Kein Ruecksync.

## Was wird gespiegelt?

Pro Spieler (= eingeloggter Soundboard-User) und pro Charakter-Blatt, das auf `dndbeyond.com/characters/<id>` offen ist:

- **HP** (current / max / temp)
- **AC**
- **Conditions** (Vergiftet, Betaeubt, …)
- **Inventar** (name / qty / type / equipped)
- **Wuerfe** aus dem DDB-Wuerfel-Toaster (best effort — DOM-Scrape)

Das Soundboard-Backend emittiert die Daten dann an alle Mitspieler in den Campaigns, in denen der User ein Token auf der aktiven Karte hat.

## Lokal laden

1. Soundboard-Backend starten (`cd BE && npm start`, Default-Port 8000).
2. Soundboard-FE starten (`cd FE/soundboard_fe && npm start`, Default-Port 8001).
3. Chrome → `chrome://extensions/` → **Entwicklermodus** einschalten.
4. **Entpackte Erweiterung laden** → Ordner `dndbeyond-extension/` waehlen.
5. Icon klicken → Popup → Backend-URL (Default `http://localhost:8000`) + Soundboard-Username + Passwort → **Anmelden**.
6. Auf `dndbeyond.com` einloggen und einen Charakter oeffnen (`/characters/<id>`).
7. Im Soundboard das Spielbrett der Campaign oeffnen, in der dein Spieler drinsteckt. Oben rechts neuer Tab **DDB**.

Alle ~4 s poll't die Extension und pusht nur Aenderungen. Wuerfe werden als Toast oben in der Mitte des Spielbretts angezeigt (auto-dismiss nach 8 s).

## Fragilitaet (ponytail)

- **DDB character-service-Schema** ist undokumentiert. Bricht bei Breaking Changes → `content.js :: extractState()` anpassen.
- **Wuerfel-Toast-Erkennung** ist DOM-Scrape ueber ein paar CSS-Klassen (`.dice-rollable-result`, `.DiceNotification`, …). Bricht bei UI-Redesign → `content.js :: diceSelectors` anpassen.
- **Robusterer Fallback** (fuer spaeter): Direktanbindung an den DDB-Game-Log-Websocket mit Cobalt-Token aus Cookies. Deutlich stabiler, aber mehr Setup.

## Dateien

- `manifest.json` — MV3-Manifest
- `popup.html` + `popup.css` + `popup.js` — Login-UI
- `content.js` — Poll + MutationObserver + POST an `/api/dndbeyond/sync`

## Backend-Route

- `POST /api/dndbeyond/sync` (Bearer-Auth)
  - Body: `{ hp?, ac?, conditions?, inventory?, diceRoll? }`
  - Server findet alle Campaigns, in denen der User ein Token hat
  - Emittet `character:update` + optional `character:diceroll` an `campaign:<id>`

- `GET /api/dndbeyond/state` (Bearer-Auth) — Debug: eigener aktueller Cache-State
