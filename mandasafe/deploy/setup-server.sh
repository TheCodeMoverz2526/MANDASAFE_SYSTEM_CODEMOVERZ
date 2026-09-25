#!/usr/bin/env bash
# MandaSafe — one-time server setup for Ubuntu 24.04 LTS.
#
#   sudo bash /var/www/mandasafe/mandasafe/deploy/setup-server.sh <domain-or-ip> [email-for-https]
#
# Expects the project already at /var/www/mandasafe (DEPLOY.md, step 3). Safe to run again:
# every step checks before it changes anything, and it never overwrites an existing .env.
set -euo pipefail

TARGET="${1:?usage: sudo bash setup-server.sh <domain-or-ip> [email-for-https]}"
EMAIL="${2:-}"
ROOT=/var/www/mandasafe
SITE="$ROOT/mandasafe"
APP="$SITE/laravel"
PHPV=8.3

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
[ -f "$APP/artisan" ] || { echo "Project not found at $SITE — upload it first (DEPLOY.md, step 3)."; exit 1; }

step "Installing packages (Nginx, PHP $PHPV, Python, Certbot)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx git unzip curl sqlite3 ufw \
    "php$PHPV-fpm" "php$PHPV-cli" "php$PHPV-sqlite3" "php$PHPV-mbstring" "php$PHPV-xml" \
    "php$PHPV-curl" "php$PHPV-zip" "php$PHPV-bcmath" "php$PHPV-intl" "php$PHPV-opcache" \
    python3-venv python3-pip certbot python3-certbot-nginx
if ! command -v composer >/dev/null; then
    curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
fi

step "Python environment for the ML models (numpy, scipy, scikit-learn)"
[ -x "$SITE/ml/.venv/bin/python" ] || python3 -m venv "$SITE/ml/.venv"
"$SITE/ml/.venv/bin/pip" install --quiet --upgrade pip
"$SITE/ml/.venv/bin/pip" install --quiet -r "$SITE/ml/requirements.txt"

step "Laravel: dependencies, settings, database"
cd "$APP"
export COMPOSER_ALLOW_SUPERUSER=1
composer install --no-dev --optimize-autoloader --no-interaction
NEW_KEY=no
if [ ! -f .env ]; then
    cp "$SITE/deploy/env.production.example" .env
    php artisan key:generate --force
    NEW_KEY=yes
fi
if [[ "$TARGET" =~ ^[0-9.]+$ ]]; then SCHEME=http; else SCHEME=https; fi
sed -i "s|^APP_URL=.*|APP_URL=$SCHEME://$TARGET|" .env
sed -i "s|^MANDASAFE_PYTHON_BIN=.*|MANDASAFE_PYTHON_BIN=$SITE/ml/.venv/bin/python|" .env
[ "$SCHEME" = http ] && sed -i "s|^SESSION_SECURE_COOKIE=.*|SESSION_SECURE_COOKIE=false|" .env

if [ ! -f database/database.sqlite ]; then
    echo "  No database uploaded — starting an empty one with the default administrator."
    touch database/database.sqlite
    php artisan migrate --force --no-interaction
    php artisan db:seed --force --no-interaction
else
    php artisan migrate --force --no-interaction
    if [ "$NEW_KEY" = yes ]; then
        # Authenticator keys are encrypted with the APP_KEY of the machine that stored them;
        # this server has a new key and could not read them (admin sign-in would fail). Clear
        # them so each administrator scans a fresh QR code at first sign-in here, and end the
        # sessions that were opened on the old machine.
        echo "  New APP_KEY for an uploaded database: resetting authenticators and sessions."
        php artisan tinker --execute="App\Models\Account::query()->update(['totp_secret'=>null,'totp_enabled_at_iso'=>null,'totp_last_step'=>null]); App\Models\RimasSession::query()->delete(); App\Models\OtpChallenge::query()->delete();"
    fi
fi

step "Permissions"
chown -R www-data:www-data "$APP/storage" "$APP/bootstrap/cache" "$APP/database"
chmod -R ug+rwX "$APP/storage" "$APP/bootstrap/cache" "$APP/database"
chmod 640 "$APP/.env" && chown root:www-data "$APP/.env"
# Nginx must be able to walk down to the static files.
chmod o+x /var/www "$ROOT" "$SITE"

step "Caching config and routes"
sudo -u www-data php artisan config:cache
sudo -u www-data php artisan route:cache

step "Nginx"
sed "s|__DOMAIN__|$TARGET|g; s|__SITE__|$SITE|g" "$SITE/deploy/nginx-mandasafe.conf" > /etc/nginx/sites-available/mandasafe
ln -sf /etc/nginx/sites-available/mandasafe /etc/nginx/sites-enabled/mandasafe
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now "php$PHPV-fpm" nginx
systemctl reload nginx

step "Firewall: SSH, HTTP and HTTPS only"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable

if [ "$SCHEME" = https ]; then
    step "HTTPS certificate (Let's Encrypt)"
    if [ -n "$EMAIL" ]; then
        certbot --nginx -d "$TARGET" --non-interactive --agree-tos -m "$EMAIL" --redirect
    else
        echo "  Skipped — no email given. Run: sudo certbot --nginx -d $TARGET"
    fi
fi

step "Pre-computing analytics (Random Forest, hotspots, Safety Index)"
sudo -u www-data php artisan mandasafe:warm || echo "  Warm-up failed; pages will compute on first visit. Check storage/logs."

echo
echo "MandaSafe is online at $SCHEME://$TARGET"
echo "Next: set a new administrator password (DEPLOY.md, step 6):"
echo "  cd $APP && sudo -u www-data php artisan mandasafe:set-password admin@rimas.gov.ph"
