/* MandaSafe sign-in.

   Accounts live in the server database, not in this browser, which is what makes one
   administrator account the same account on every device.

   The verification step is the server's too. This page never generates a code, never learns
   what the code is, and never decides whether the one that was typed is right: it starts a
   challenge, asks for the code to be sent, and posts the six digits back for checking. The
   only thing it holds is `challenge.id` — a random handle that is useless once spent.
   Signing in issues no session until the code has been accepted. */

const SESSION_KEY = 'rimasCurrentUser';
const TOKEN_KEY = 'rimasToken';
const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:5500' : '';

/* { id, purpose, name, email, phone, channels, testMode, channel } — everything here came
   from the server, and the contacts arrive already masked. */
let challenge = null;
let resendInterval = null;

/* ---------- API ---------- */
async function api(path, options = {}) {
    let response;
    try {
        response = await fetch(API_BASE + path, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
    } catch (error) {
        throw new Error('Cannot reach the MandaSafe server. Start it with start-mandasafe.bat, then reload this page.');
    }
    let data = null;
    try { data = await response.json(); } catch { /* no body */ }
    if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status})`);
    return data;
}

/* ---------- helpers ---------- */
function normalisePhone(value) { return value.replace(/[^+\d]/g, '').replace(/^00/, '+'); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function showError(id, message) { const box = document.getElementById(id); box.textContent = message; box.style.display = 'block'; }
function clearErrors() { document.querySelectorAll('.auth-error').forEach(error => { error.textContent = ''; error.style.display = 'none'; }); }
function showPanel(id) { document.querySelectorAll('.auth-panel').forEach(panel => panel.classList.toggle('active', panel.id === id)); clearErrors(); }
function setBusy(on) { document.querySelectorAll('.auth-submit').forEach(b => b.disabled = on); }

function togglePassword(id, button) {
    const input = document.getElementById(id);
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    button.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
    button.querySelector('i').className = `fas ${visible ? 'fa-eye' : 'fa-eye-slash'}`;
}

function updatePasswordStrength(password) {
    const meter = document.getElementById('passwordStrength'); if (!meter) return;
    if (!password) { meter.hidden = true; return; }
    const groups = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)].filter(Boolean).length;
    const state = password.length >= 12 && groups >= 3 ? 'strong' : password.length >= 8 && groups >= 2 ? 'moderate' : 'weak';
    meter.hidden = false; meter.className = `password-strength ${state}`;
    meter.querySelector('.strength-label').textContent = state === 'strong' ? 'Strong password' : state === 'moderate' ? 'Moderate password' : 'Weak password';
}

function openPrivacyPolicy(event) { event.preventDefault(); document.getElementById('privacyPolicy').classList.add('open'); }
function closePrivacyPolicy() { document.getElementById('privacyPolicy').classList.remove('open'); }

/* The session the dashboard reads: the server-issued token plus the account's role,
   so Mandasafe.html shows admin tools only to real administrators. */
function completeLogin(session) {
    localStorage.setItem(TOKEN_KEY, session.token);
    localStorage.setItem(SESSION_KEY, JSON.stringify({
        id: session.account.id,
        name: session.account.name,
        email: session.account.email,
        avatar: session.account.avatar,
        color: session.account.color,
        role: session.account.role,
        dept: session.account.dept
    }));
    // Administrators go to the RIMAS console; residents go to the public dashboard.
    window.location.assign(session.account.role === 'admin' ? 'Mandasafe.html' : 'dashboard.html');
}

/* ---------- step one: state the intent ----------
   Each of the three entry points posts what it has and gets back a challenge. Nothing is
   granted here: no session for a sign-in, no account for a sign-up, no password change for
   a reset — all three wait for the code. */

async function beginRegistration() {
    const name = document.getElementById('createName').value.trim();
    const email = document.getElementById('createEmail').value.trim().toLowerCase();
    const phone = normalisePhone(`${document.getElementById('countryCode').value}${document.getElementById('createPhone').value}`);
    const password = document.getElementById('createPassword').value;
    const confirmation = document.getElementById('confirmPassword').value;

    // Checked again on the server; this is only to answer the obvious mistakes instantly.
    if (!validEmail(email)) return showError('createError', 'Enter a valid email address.');
    if (phone.length < 9) return showError('createError', 'Enter a valid contact number.');
    if (password.length < 8) return showError('createError', 'Password must be at least 8 characters.');
    if (password !== confirmation) return showError('createError', 'Your password and confirmation do not match.');
    if (!document.getElementById('privacyAgreement').checked) return showError('createError', 'You must agree to the Privacy Policy to create an account.');

    setBusy(true);
    try {
        // The server validates the details and holds them until the code is accepted — the
        // account is written only then, so no unverified number ever becomes an account.
        const started = await api('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ name, email, phone, password })
        });
        openChallenge(started);
    } catch (error) {
        showError('createError', error.message);
    } finally {
        setBusy(false);
    }
}

async function beginLogin() {
    const identifier = document.getElementById('loginIdentifier').value.trim();
    const password = document.getElementById('loginPassword').value;
    setBusy(true);
    try {
        // The password is checked here, but no token comes back yet: the session is created
        // at /api/auth/otp/verify and nowhere else.
        const started = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) });
        openChallenge(started);
    } catch (error) {
        showError('loginError', error.message);
    } finally {
        setBusy(false);
    }
}

async function beginPasswordReset() {
    const identifier = document.getElementById('resetIdentifier').value.trim();
    setBusy(true);
    try {
        const started = await api('/api/auth/contact', { method: 'POST', body: JSON.stringify({ identifier }) });
        openChallenge(started);
    } catch (error) {
        showError('forgotError', error.message);
    } finally {
        setBusy(false);
    }
}

/* ---------- step two: choose a channel and have the code sent ---------- */

function openChallenge(started) {
    challenge = { ...started, id: started.challengeId, channel: null };

    document.getElementById('emailDestination').textContent = challenge.email || 'Not available';
    document.getElementById('smsDestination').textContent = challenge.phone || 'Not available';
    document.getElementById('channelDescription').textContent = challenge.purpose === 'register'
        ? 'Choose how you would like to verify your new account.'
        : 'Select where we should send your six-digit verification code.';

    // A channel the server cannot deliver on is shown as unavailable rather than failing
    // after the tap.
    const channels = challenge.channels || {};
    [['emailChannel', channels.email], ['smsChannel', channels.sms]].forEach(([id, available]) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.disabled = !available;
        button.title = available ? '' : 'This verification method is not available right now.';
    });

    showPanel('channelPanel');
}

async function sendOtp(channel) {
    if (!challenge) return showError('channelError', 'This verification has expired. Please start again.');

    setBusy(true);
    try {
        const sent = await api('/api/auth/otp/send', {
            method: 'POST',
            body: JSON.stringify({ challengeId: challenge.id, channel })
        });
        challenge.channel = channel;
        showOtpPanel(sent);
    } catch (error) {
        // Stay on whichever panel the person can act from.
        showError(document.getElementById('otpPanel').classList.contains('active') ? 'otpError' : 'channelError', error.message);
    } finally {
        setBusy(false);
    }
}

function showOtpPanel(sent) {
    document.getElementById('otpTitle').textContent = challenge.purpose === 'login' ? 'Verify your sign in' : 'Enter verification code';
    document.getElementById('otpDescription').textContent =
        `We sent a six-digit ${sent.channel === 'email' ? 'email' : 'SMS'} code to ${sent.destination}.`;
    document.querySelectorAll('.otp-inputs input').forEach(input => input.value = '');

    // In test mode the server tells us the code it generated, because no provider was
    // contacted. With real credentials this field is simply absent.
    const hint = document.getElementById('demoOtp');
    hint.hidden = !sent.testCode;
    hint.textContent = sent.testCode ? `Test mode — your code is ${sent.testCode}` : '';

    showPanel('otpPanel');
    startResendTimer(sent.resendIn || 30);
    setTimeout(() => document.querySelector('.otp-inputs input').focus(), 0);
}

function startResendTimer(seconds) {
    clearInterval(resendInterval);
    const timer = document.getElementById('resendTimer');
    const button = document.getElementById('resendButton');
    button.disabled = true;
    const render = () => { timer.textContent = `Resend code in 00:${String(seconds).padStart(2, '0')}`; };
    render();
    resendInterval = setInterval(() => {
        seconds -= 1;
        if (seconds <= 0) { clearInterval(resendInterval); timer.textContent = 'Did not receive a code?'; button.disabled = false; return; }
        render();
    }, 1000);
}

function resendOtp() { if (challenge && challenge.channel) sendOtp(challenge.channel); }

function cancelVerification() {
    clearInterval(resendInterval);
    // Tell the server to drop it as well, rather than leaving a live challenge behind.
    if (challenge) api('/api/auth/otp/cancel', { method: 'POST', body: JSON.stringify({ challengeId: challenge.id }) }).catch(() => { });
    challenge = null;
    showPanel('signInPanel');
}

/* ---------- step three: the code ---------- */

function enteredOtp() { return [...document.querySelectorAll('.otp-inputs input')].map(input => input.value).join(''); }

async function verifyOtp() {
    if (!challenge) return showError('otpError', 'This verification has expired. Please start again.');

    const code = enteredOtp();
    if (!/^\d{6}$/.test(code)) return showError('otpError', 'Enter all six digits of your code.');

    setBusy(true);
    try {
        // The server checks the code (or asks the SMS provider to) and answers with the
        // outcome of the flow — never with the code itself.
        const result = await api('/api/auth/otp/verify', {
            method: 'POST',
            body: JSON.stringify({ challengeId: challenge.id, code })
        });
        clearInterval(resendInterval);

        if (challenge.purpose === 'login') {
            challenge = null;
            return completeLogin(result);
        }

        if (challenge.purpose === 'register') {
            document.getElementById('loginIdentifier').value = result.account.email;
            document.getElementById('loginPassword').value = '';
            challenge = null;
            showPanel('signInPanel');
            return showError('loginError', 'Account created and verified. You can now sign in.');
        }

        // A reset: the challenge stays alive for a few minutes so the new password can be
        // set against it, and for nothing else.
        return showPanel('newPasswordPanel');
    } catch (error) {
        showError('otpError', error.message);
    } finally {
        setBusy(false);
    }
}

async function finishPasswordReset() {
    if (!challenge) return showError('newPasswordError', 'This password reset has expired. Please start again.');

    const password = document.getElementById('newPassword').value;
    const confirmation = document.getElementById('newPasswordConfirm').value;
    if (password.length < 8) return showError('newPasswordError', 'Password must be at least 8 characters.');
    if (password !== confirmation) return showError('newPasswordError', 'Your password and confirmation do not match.');

    setBusy(true);
    try {
        // The server refuses this unless it was this challenge that passed verification.
        const account = await api('/api/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({ challengeId: challenge.id, password })
        });
        document.getElementById('loginIdentifier').value = account.email;
        document.getElementById('loginPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('newPasswordConfirm').value = '';
        challenge = null;
        showPanel('signInPanel');
        showError('loginError', 'Password updated. Sign in with your new password.');
    } catch (error) {
        showError('newPasswordError', error.message);
    } finally {
        setBusy(false);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Signing in needs the server: opened from the folder, every /api/ call would fail.
    if (window.location.protocol === 'file:') {
        showError('loginError', 'Open MandaSafe through http://localhost:5500/ — start it with start-mandasafe.bat first.');
    }

    // The homepage links to login.html#signup — open the create-account panel directly.
    if (window.location.hash === '#signup') showPanel('createPanel');

    document.getElementById('createPassword').addEventListener('input', event => updatePasswordStrength(event.target.value));
    document.querySelectorAll('.otp-inputs input').forEach((input, index, inputs) => {
        input.addEventListener('input', event => {
            input.value = event.target.value.replace(/\D/g, '').slice(-1);
            if (input.value && inputs[index + 1]) inputs[index + 1].focus();
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Backspace' && !input.value && inputs[index - 1]) inputs[index - 1].focus();
        });
        input.addEventListener('paste', event => {
            event.preventDefault();
            const digits = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
            [...digits].forEach((digit, digitIndex) => { if (inputs[digitIndex]) inputs[digitIndex].value = digit; });
            inputs[Math.min(digits.length, 5)].focus();
        });
    });
});

if (localStorage.getItem(SESSION_KEY) && localStorage.getItem(TOKEN_KEY)) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { /* ignore */ }
    window.location.replace(saved && saved.role === 'admin' ? 'Mandasafe.html' : 'dashboard.html');
}
