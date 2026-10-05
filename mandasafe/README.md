# MandaSafe — combined system
Mandaluyong City Traffic Planning and Management Office

One folder, one server, one database. The backend is **Laravel 12** (`laravel/`); the pages are
the same HTML/CSS/JS they always were and sit in this folder. It serves **two faces**:

| | Who | Entry point | What they can do |
|---|---|---|---|
| **Resident side** | anyone with an account | `index.html` → `dashboard.html` | View incidents, maps, hotspots, forecasts and the safety index. **Read-only.** |
| **Admin console (RIMAS)** | administrators only | `Mandasafe.html` | Record and edit incidents and baseline prediction data, manage user accounts, export reports. |

## Start it

Double-click **`start-mandasafe.bat`**. It installs anything missing, prepares the database and
starts the server. Then open:

- `http://localhost:5500/` — public landing page, no sign-in needed
- `http://localhost:5500/login.html` — sign in

Signing in routes you automatically: **administrators → the RIMAS console**, **residents → the dashboard**.

By hand, the same thing is:

```
cd laravel
composer install
php artisan migrate
php artisan db:seed          # creates the administrator if missing and prints its password once
php artisan serve --port=5500
```

Requirements: **PHP 8.2+** and **Composer** (both come with XAMPP — add `C:\xampp\php` to PATH),
plus **Python 3.9+** with `ml/requirements.txt` installed (`pip install -r ml/requirements.txt`)
for the predictions and hotspots — `start-mandasafe.bat` installs it on first run. No web server,
MySQL or Node.js is needed to run it.

## Accounts

| Role | Email |
|---|---|
| Administrator | `admin@rimas.gov.ph` |
| Resident (demo) | `juan@example.com` |

No password is written in the code or in this file. A new database gets an administrator from
`php artisan db:seed`, with the password in `MANDASAFE_ADMIN_PASSWORD` or a random one printed
once. Set or change any password with `php artisan mandasafe:set-password <email>`.

The sample passwords earlier versions published still work on a development PC, but **in
production (`APP_ENV=production`) they are refused at sign-in** until the password is changed.
New sign-ups are always residents; an admin promotes them from **User Management**.

> The old JSON store held Node `scrypt` password hashes, which PHP cannot verify, so
> `php artisan mandasafe:import` gives every imported account a new password (random, or
> `--fallback-password`) and prints the list.

## The database

`data/store.json` has become real tables. SQLite is the default, so there is nothing to install
or start — the file is `laravel/database/database.sqlite`.

| Table | Was |
|---|---|
| `incidents` | `store.incidents` |
| `prediction_inputs` | `store.predictionInputs` |
| `accounts` | `store.accounts` (bcrypt instead of scrypt) |
| `rimas_sessions` | `store.sessions` |
| `rimas_settings` | the `next…Seq` counters, plus the analytics cache version |

Ids stay human-readable (`#A18037`, `RF-1001`, `USR-1001`) because they are printed on reports,
and a `sort_key` column preserves the newest-first order the JSON array had.

**To re-import** the JSON store (it is untouched, and still there):

```
php artisan mandasafe:import --fresh
```

**To use MySQL instead** — create a database, then in `laravel/.env`:

```
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=mandasafe
DB_USERNAME=root
DB_PASSWORD=
```

then `php artisan migrate:fresh` and `php artisan mandasafe:import`.

## The map

Every map on both sides draws the **same official boundaries** — the 27 barangay polygons in
`data/mandaluyong-barangays.geojson`, which the server also uses for barangay centroids. The
resident maps mask out everything beyond the city, lock panning to the city bounds, shade each
barangay by its incident count, and label it on hover.

## Pages

**Resident side**

| Page | Shows |
|---|---|
| `index.html` | Public landing: live barangay map, city totals, predicted high-risk locations |
| `dashboard.html` | Totals, barangay choropleth, latest reports, monthly trend, worst barangays |
| `incident-map.html` | Full map + filters (barangay, severity, type, year, free text) and a results table |
| `hotspots.html` | KDE density heatmap, ranked hotspot areas, next-month forecast table |
| `safety-index.html` | 0–100 safety score computed from the data, with its five categories |
| `announcements.html` | Advisories generated from the current figures |
| `profile.html` | The signed-in account, straight from the database |
| `about.html`, `support.html` | Background and hotlines |

**Admin side** — `Mandasafe.html` + `script.js`.

## Data flow

```
Admin (Mandasafe.html) ──writes──▶ Laravel API ──▶ database ◀── Resident pages + public landing
                                        │
              PredictionService (trend + forest) · KdeService (hotspots) ──▶ ml/*.py (scikit-learn)
```

The Random Forest severity classifier and the KDE hotspot surface are both computed by Python
(scikit-learn) in `ml/`, one level above `laravel/` — `MlBridge` shells out to it, feeding a
script JSON on stdin and reading JSON back from stdout. `MANDASAFE_PYTHON_BIN` in `.env` points
at the interpreter to use; it defaults to whatever `python` resolves to on PATH.

Reading is open, writing is not:

| | Anonymous | Resident | Admin |
|---|---|---|---|
| `GET /api/summary`, `/api/incidents`, `/api/predictions`, `/api/hotspots`, `/api/stats` | ✅ | ✅ | ✅ |
| `POST/PUT/DELETE` incidents, prediction inputs, accounts | 401 | 403 | ✅ |

A resident who types the admin URL is sent back to their dashboard, and the server rejects the
write anyway — the role is read from the database on every request, not from the browser.

`GET /api/summary` is one small payload (totals, per-barangay counts with centroids, monthly
trend, type/severity mix, top forecasts, newest reports) so the resident pages don't download
all ~8,000 incident rows.

### Verification (sign in, sign up, forgot password)

All three go through the same three steps, and all three are decided on the server:

| Step | Endpoint | What happens |
|---|---|---|
| 1 | `POST /api/auth/login` · `/register` · `/contact` | Proves what can be proved now (the password, the sign-up details, that the account exists) and answers with a **challenge id** and the contacts masked. No session, no account, no password change yet. |
| 2 | `POST /api/auth/otp/send` | Sends the six-digit code to the chosen channel. |
| 3 | `POST /api/auth/otp/verify` | Checks the code, then issues the session / creates the account / unlocks `POST /api/auth/reset-password`. |

The browser never generates the code, never receives it, and never decides whether it matched.
It holds only the challenge id — a random 32-byte handle that is deleted once spent. A sign-in
issues its token in step 3 and nowhere else, and a password reset is refused unless it quotes a
challenge that passed step 3 in the last ten minutes.

Per challenge: 10 minutes to use it, 5 codes, 5 guesses in total, 30 seconds between codes —
counted in the `otp_challenges` table, with further per-IP and per-destination limits on top.

**SMS — Vocotext iSMS 2FA.** The provider generates the code, substitutes it for `%OTP%` in
the message, and verifies it on its side, so those digits are never stored here; MandaSafe
keeps only the `uuid` / `sms_id` pair needed to ask. Numbers are stored as `+639171234599` and
split into `country_code=63` + `mobile=9171234599` on the way out. Set in `laravel/.env`:

```
OTP_TEST_MODE=false
VOCOTEXT_USERNAME=...
VOCOTEXT_PASSWORD=...
VOCOTEXT_SENDER_ID=MandaSafe
```

**Email — Resend** (`RESEND_API_KEY`, `OTP_FROM_EMAIL`) is optional; for that channel the code
is generated here and only its bcrypt hash is stored. Twilio still works as an SMS fallback
when Vocotext is not configured.

**Credentials win over test mode.** `OTP_TEST_MODE=true` is only the fallback for a system
with no provider configured yet: it generates the code locally and shows it on the sign-in
page so MandaSafe can be demonstrated. The moment `VOCOTEXT_USERNAME` and `VOCOTEXT_PASSWORD`
(or the Resend pair) are filled in, real messages go out and nothing is echoed to the browser
— whatever `OTP_TEST_MODE` still says.

To check the credentials without going through the sign-in page:

```
php artisan mandasafe:otp-check                   # what is live
php artisan mandasafe:otp-check +639171234599     # send a real code to that number
```

### Caching

The forecasts and the KDE hotspot surface are the only heavy work, and they only change when
the data does, so each is computed once and cached until the next write. After a large import,
`php artisan mandasafe:warm` computes them up front. `MANDASAFE_ANALYTICS_CACHE=0` turns the
cache off.

## Folder

```
laravel/                                                     the backend
  app/Models/          Incident, PredictionInput, Account, RimasSession, Setting,
                       OtpChallenge
  app/Services/        AccountService, VerificationService, OtpService, PredictionService,
                       MlBridge, KdeService, GeoService, AnalyticsService
  app/Http/            controllers under Api/, the RimasAdmin middleware,
                       StaticSiteController (serves the pages in this folder)
  routes/api.php       every /api endpoint
  database/            migrations, the SQLite file
  tests/Feature/       MandaSafeApiTest — the access rules and payload shapes
ml/                                                          the ML backend (Python)
  severity_forest.py   scikit-learn Random Forest: severity probability per barangay/road
  hotspots.py          scikit-learn KDE: the hotspot density surface
  requirements.txt      numpy, scipy, scikit-learn
login.html  login.js  styles.css                             shared sign-in
Mandasafe.html  script.js                                    admin console
index.html  dashboard.html  incident-map.html  hotspots.html resident pages
safety-index.html  announcements.html  profile.html  about.html  support.html
css/style.css   js/api.js  js/app.js  js/map.js              resident assets
assets/         vendor/leaflet/                              images, Leaflet
data/mandaluyong-barangays.geojson                           official boundaries
data/store.json  data/store.backup.json                      the original JSON store
server.js  db.js  auth.js  geo.js  kde.js  prediction.js  mlBridge.js
                                                             the previous Node backend, kept
                                                             for reference; no longer used, but
                                                             still calls into ml/ if you do
```

Leaflet is served from `vendor/`, so the maps work without internet — only the OpenStreetMap
background tiles need a connection.

## Checking it

```
cd laravel
php artisan test
```

## Access from a phone

`php artisan serve` listens on `127.0.0.1` only. For other devices on the same Wi-Fi:

```
php artisan serve --host=0.0.0.0 --port=5500
```

then open `http://<your-PC-IP>:5500/`. Windows Firewall will ask to allow PHP the first time.
