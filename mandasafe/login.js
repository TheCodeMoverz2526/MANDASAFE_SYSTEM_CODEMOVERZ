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
        // The start-the-server hint is for a developer's own PC; online, visitors get a plain message.
        throw new Error(['localhost', '127.0.0.1'].includes(location.hostname)
            ? 'Cannot reach the MandaSafe server. Start it with start-mandasafe.bat, then reload this page.'
            : 'MandaSafe is not responding right now. Please check your connection and try again in a moment.');
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

function openPrivacyPolicy(event) {
    event.preventDefault();
    document.getElementById('privacyPolicy').classList.add('open');
    const body = document.querySelector('#privacyPolicy .privacy-body');
    if (body) { body.scrollTop = 0; body.focus(); }
}
function closePrivacyPolicy() { document.getElementById('privacyPolicy').classList.remove('open'); }
/* "I Agree" in the policy ticks the consent box on the sign-up form — the same choice as
   ticking it by hand, made right after reading the policy. */
function agreePrivacyPolicy() {
    const box = document.getElementById('privacyAgreement');
    if (box) box.checked = true;
    closePrivacyPolicy();
}

// The policy opens at the top every time, and closes with Escape or a click outside it.
document.addEventListener('keydown', event => { if (event.key === 'Escape') closePrivacyPolicy(); });
document.addEventListener('click', event => { if (event.target && event.target.id === 'privacyPolicy') closePrivacyPolicy(); });

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
        // No verification code: the server validates the details and creates the account.
        const result = await api('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ name, email, phone, password })
        });
        document.getElementById('loginIdentifier').value = result.account.email;
        document.getElementById('loginPassword').value = '';
        ['createName', 'createEmail', 'createPhone', 'createPassword', 'confirmPassword'].forEach(id => document.getElementById(id).value = '');
        document.getElementById('privacyAgreement').checked = false;
        updatePasswordStrength('');
        showPanel('signInPanel');
        showError('loginError', 'Account created. You can now sign in.');
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
        // A correct password signs a resident straight in. An administrator gets a challenge
        // instead, closed by the code from their authenticator app.
        const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) });
        if (result.totpRequired) return showTotpPanel(result);
        completeLogin(result);
    } catch (error) {
        showError('loginError', error.message);
    } finally {
        setBusy(false);
    }
}

/* Password recovery is by registered email only: there is no channel to choose, so the code
   is sent to the account's email address as soon as the server has found the account. */
async function beginPasswordReset() {
    const email = document.getElementById('resetEmail').value.trim().toLowerCase();
    if (!validEmail(email)) return showError('forgotError', 'Enter a valid email address.');

    clearErrors();
    setBusy(true);
    let started;
    try {
        started = await api('/api/auth/contact', { method: 'POST', body: JSON.stringify({ email }) });
    } catch (error) {
        return showError('forgotError', error.message);
    } finally {
        setBusy(false);
    }

    challenge = { ...started, id: started.challengeId, channel: null };
    if (!(started.channels || {}).email) {
        return showError('forgotError', 'Email verification is not available right now. Please try again later.');
    }
    sendOtp('email');
}

/* ---------- step two: have the code emailed ---------- */

async function sendOtp(channel) {
    if (!challenge) return showError('forgotError', 'This verification has expired. Please start again.');

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
        const active = document.querySelector('.auth-panel.active');
        showError(active && active.id === 'otpPanel' ? 'otpError' : 'forgotError', error.message);
    } finally {
        setBusy(false);
    }
}

function showOtpPanel(sent) {
    document.getElementById('otpTitle').textContent = challenge.purpose === 'login' ? 'Verify your sign in' : 'Enter verification code';
    document.getElementById('otpDescription').textContent =
        `We sent a six-digit ${sent.channel === 'email' ? 'email' : 'SMS'} code to ${sent.destination}.`;
    document.querySelectorAll('.otp-inputs input').forEach(input => input.value = '');

    // Until email delivery is set up, the server hands back the code it generated so it can
    // be shown here. With real credentials this field is simply absent.
    const hint = document.getElementById('demoOtp');
    hint.hidden = !sent.testCode;
    hint.textContent = sent.testCode ? `Your verification code: ${sent.testCode}` : '';
    if (sent.testCode) document.getElementById('otpDescription').textContent = 'Enter the six-digit code shown below the boxes.';

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

/* Going back means entering a different email — the challenge for the old one is dropped on
   the server first. */
function leaveOtpPanel() {
    clearInterval(resendInterval);
    if (!challenge) return showPanel('forgotPanel');
    api('/api/auth/otp/cancel', { method: 'POST', body: JSON.stringify({ challengeId: challenge.id }) }).catch(() => { });
    challenge = null;
    showPanel('forgotPanel');
}

function cancelVerification() {
    clearInterval(resendInterval);
    // Tell the server to drop it as well, rather than leaving a live challenge behind.
    if (challenge) api('/api/auth/otp/cancel', { method: 'POST', body: JSON.stringify({ challengeId: challenge.id }) }).catch(() => { });
    challenge = null;
    showPanel('signInPanel');
}

/* ---------- step three: the code ---------- */

function enteredOtp(groupSelector = '#otpPanel .otp-inputs') { return [...document.querySelectorAll(`${groupSelector} input`)].map(input => input.value).join(''); }

/* ---------- administrators: authenticator app (TOTP) ----------
   On the first sign-in the server hands over a new secret to scan; it is only kept once a
   code from the app has been accepted. After that, just the six digits are asked for. */

function showTotpPanel(started) {
    challenge = { id: started.challengeId, purpose: 'totp' };
    const enroll = !!started.enroll;

    document.getElementById('totpTitle').textContent = enroll ? 'Set up your authenticator app' : 'Enter authenticator code';
    document.getElementById('totpDescription').textContent = enroll
        ? 'Administrator accounts need a second step. Scan this QR code with Google Authenticator, Microsoft Authenticator or a similar app, then enter the six-digit code it shows.'
        : 'Open your authenticator app and enter the six-digit code shown for MandaSafe.';

    const setup = document.getElementById('totpSetup');
    const qrBox = document.getElementById('totpQr');
    setup.hidden = !enroll;
    qrBox.innerHTML = '';
    document.getElementById('totpSecret').textContent = enroll ? started.secret.replace(/(.{4})/g, '$1 ').trim() : '';
    if (enroll && typeof qrcode === 'function') {
        const qr = qrcode(0, 'M');
        qr.addData(started.otpauthUri);
        qr.make();
        qrBox.innerHTML = qr.createImgTag(4, 0);
    }

    document.querySelectorAll('#totpInputs input').forEach(input => input.value = '');
    showPanel('totpPanel');
    setTimeout(() => document.querySelector('#totpInputs input').focus(), 0);
}

async function verifyTotp() {
    if (!challenge || challenge.purpose !== 'totp') return showError('totpError', 'This sign-in has expired. Please start again.');

    const code = enteredOtp('#totpInputs');
    if (!/^\d{6}$/.test(code)) return showError('totpError', 'Enter all six digits from your authenticator app.');

    setBusy(true);
    try {
        const session = await api('/api/auth/totp/verify', {
            method: 'POST',
            body: JSON.stringify({ challengeId: challenge.id, code })
        });
        challenge = null;
        completeLogin(session);
    } catch (error) {
        document.querySelectorAll('#totpInputs input').forEach(input => input.value = '');
        document.querySelector('#totpInputs input').focus();
        showError('totpError', error.message);
    } finally {
        setBusy(false);
    }
}

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
    // Each six-box group moves focus within itself only (there is one on the email/SMS panel
    // and one on the authenticator panel).
    document.querySelectorAll('.otp-inputs').forEach(group => group.querySelectorAll('input').forEach((input, index, inputs) => {
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
    }));
});

if (localStorage.getItem(SESSION_KEY) && localStorage.getItem(TOKEN_KEY)) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { /* ignore */ }
    window.location.replace(saved && saved.role === 'admin' ? 'Mandasafe.html' : 'dashboard.html');
}
