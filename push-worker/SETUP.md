# Setup notifiche push DroneWind

## Prerequisiti
- Account gratuito su https://dash.cloudflare.com (no carta di credito)
- Node.js installato

## Step 1 — Installa Wrangler (CLI Cloudflare)
```
npm install -g wrangler
```

## Step 2 — Login
```
wrangler login
```
Si apre il browser, accedi con il tuo account Cloudflare.

## Step 3 — Crea il KV namespace
```
wrangler kv namespace create SUBS
```
Copia l'ID che ti restituisce (tipo `abc123def456`).

## Step 4 — Aggiorna wrangler.toml
Apri `push-worker/wrangler.toml` e sostituisci `YOUR_KV_NAMESPACE_ID` con l'ID copiato.

## Step 5 — Deploy
```
cd push-worker
wrangler deploy
```
Ti restituisce un URL tipo: `https://dronewind-push.TUO-SUBDOMAIN.workers.dev`

## Step 6 — Aggiorna l'app
Apri `index.html` e cerca `PUSH_SERVER` — sostituisci l'URL con quello del tuo worker:
```
const PUSH_SERVER='https://dronewind-push.TUO-SUBDOMAIN.workers.dev';
```

## Step 7 — Testa
1. Apri l'app
2. Vai in Config > Notifiche push > "Attiva notifiche push"
3. Accetta il permesso del browser
4. Per testare: visita `https://dronewind-push.TUO-SUBDOMAIN.workers.dev/check`

## Come funziona
- Il worker controlla il meteo ogni 3 ore (6, 9, 12, 15, 18, 21)
- Alle 6 invia un riepilogo degli spot volabili
- Se le condizioni migliorano (da NO VOLO/ATTENZIONE a BUONO/OTTIMO), invia un avviso
- Le notifiche arrivano anche con l'app chiusa (su Chrome/Edge/Android)
- Su iOS le notifiche push richiedono che l'app sia installata come PWA

## Costi
Tutto gratuito:
- Cloudflare Workers free tier: 100.000 richieste/giorno
- KV storage free: 100.000 letture/giorno, 1.000 scritture/giorno
- Open-Meteo: gratuito
- Nessun abbonamento, nessuna carta di credito
