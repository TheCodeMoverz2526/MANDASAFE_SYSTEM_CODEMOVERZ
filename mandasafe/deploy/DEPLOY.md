# Putting MandaSafe online (demo on a cloud VPS)

This puts MandaSafe on a public web address for a capstone demo or defense. It takes about
30–45 minutes the first time. You need a credit/debit card for the VPS (roughly US$6–12 a
month; delete the server after the defense to stop paying).

**Before you start**

- The site carries the Mandaluyong City TPMO name. While it is a demo, keep the yellow
  notice bar on (`MANDASAFE_DEMO_NOTICE`, on by default) so no one takes it for an official
  City website. A real public launch needs the TPMO's approval.
- Sign-up needs no code. **Forgot password?** needs email (or SMS) delivery — see step 5;
  without it, that page says verification is unavailable. Codes are never shown on the page
  online, so no one can reset someone else's password.

---

## 1. Create the server

Any provider works — DigitalOcean, AWS Lightsail, Vultr, Hostinger VPS. Choose:

- **Ubuntu 24.04 LTS**
- **2 GB RAM** (the machine-learning models need it; 1 GB is too tight)
- A region close to the Philippines (Singapore)
- Log in with an **SSH key** if the provider offers it, otherwise a strong root password

Write down the server's **public IP address** (e.g. `203.0.113.25`).

## 2. Get a web address (recommended)

With a name you get HTTPS (the padlock) — without it, passwords travel unencrypted.

- **Free:** create a subdomain at <https://www.duckdns.org> (e.g. `mandasafe-demo.duckdns.org`)
  and set its IP to your server's IP.
- **Paid:** any domain; add an **A record** pointing to the server's IP.

Wait until it resolves — on your PC: `nslookup mandasafe-demo.duckdns.org` should show the IP.

*No name?* You can use the bare IP instead; the site then runs on plain `http://` only.

## 3. Put the project on the server

The server gets the code from GitHub, and the database (not in git) from your PC.

**a. Push today's code** from your PC (in the project folder):

```powershell
git add -A
git commit -m "Prepare MandaSafe for VPS deployment"
git push
```

**b. On the server** (connect with `ssh root@203.0.113.25`):

```bash
mkdir -p /var/www && cd /var/www
git clone https://github.com/TheCodeMoverz2526/MANDASAFE_SYSTEM_CODEMOVERZ.git mandasafe
```

The repository is private, so git asks for a username and password: use your GitHub
username and a **personal access token** (GitHub → Settings → Developer settings → Personal
access tokens → *Fine-grained*, read-only access to this repository) as the password.

**c. Upload the database** — it holds the 7,991 accident records and the accounts. On your
PC, in PowerShell, from the project folder:

```powershell
scp mandasafe\laravel\database\database.sqlite root@203.0.113.25:/var/www/mandasafe/mandasafe/laravel/database/
```

(Skip this to start with an empty database and only an administrator account.)

## 4. Run the setup script

On the server — replace the address and email with yours:

```bash
sudo bash /var/www/mandasafe/mandasafe/deploy/setup-server.sh mandasafe-demo.duckdns.org you@example.com
```

It installs Nginx, PHP 8.3, Python with scikit-learn, sets up the database, the firewall and
the HTTPS certificate, and pre-computes the forecasts. At the end it prints the site address.

With only an IP: `sudo bash …/setup-server.sh 203.0.113.25`

## 5. Settings (optional)

Edit `/var/www/mandasafe/mandasafe/laravel/.env` (`sudo nano …`). The useful ones:

| Setting | What it does |
|---|---|
| `MANDASAFE_DEMO_NOTICE` | The yellow bar on every page. Keep it for a demo. |
| `OTP_TEST_MODE` | Ignored online (codes are never shown in production). Leave `false`. |
| `RESEND_API_KEY`, `OTP_FROM_EMAIL` | Real email codes (<https://resend.com>, free tier). |
| `VOCOTEXT_USERNAME`, `VOCOTEXT_PASSWORD` | Real SMS codes. |

After any change:

```bash
cd /var/www/mandasafe/mandasafe/laravel && sudo -u www-data php artisan config:cache
```

Check email/SMS with `sudo -u www-data php artisan mandasafe:otp-check`.

## 6. Secure the administrator — required

The setup script already asked you for a new administrator password. Earlier versions had a
published default password; online it is refused at sign-in, so the administrator cannot sign
in until a new one is set. To set or change it at any time:

```bash
cd /var/www/mandasafe/mandasafe/laravel
sudo -u www-data php artisan mandasafe:set-password admin@rimas.gov.ph
```

Then open the site, sign in as the administrator, and **scan the new authenticator QR code**
(the server has its own encryption key, so the authenticator from your PC was reset).
Delete the old MandaSafe entry from your authenticator app.

## 7. Check it works

- [ ] The home page opens with the padlock (HTTPS) and the yellow demo bar
- [ ] A resident can sign up and sign in
- [ ] The administrator signs in with password + authenticator code
- [ ] Accident Map, Hotspots, Forecast and Safety Index show data
- [ ] `https://your-address/data/store.json` shows **Not found** (private data stays private)

## Updating after changes

Push from your PC (`git push`), then on the server:

```bash
cd /var/www/mandasafe && git pull
cd mandasafe/laravel
composer install --no-dev --optimize-autoloader --no-interaction
sudo -u www-data php artisan migrate --force
sudo -u www-data php artisan config:cache && sudo -u www-data php artisan route:cache
sudo -u www-data php artisan mandasafe:warm
```

## When it goes wrong

- **Error page / blank page:** `sudo tail -50 /var/www/mandasafe/mandasafe/laravel/storage/logs/laravel-*.log`
- **Forecast says "linear trend (heuristic)":** the Python models are failing — the same log shows why.
- **Site unreachable:** `sudo systemctl status nginx php8.3-fpm` and check the provider's firewall allows ports 80 and 443.

## After the defense

Destroy the server in your provider's dashboard so billing stops. The database on it has
real account emails and phone numbers, so do not leave it running unattended.

## Good to know

- `data/store.json` (the old Node server's data, with password hashes) is committed to the
  private GitHub repository. The web server never serves it, but consider removing it from
  git once no one uses the Node server any more.
- Only the files the pages need are public; everything else in the project returns
  "Not found" — see `StaticSiteController::isPublic()`.
