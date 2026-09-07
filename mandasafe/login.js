/* RIMAS sign-in.
   Accounts are NOT kept in this browser any more — they live in the server database
   (data/store.json, see auth.js). That is what makes one administrator account the same
   account on every device, and lets the server decide who is allowed to change data. */

const SESSION_KEY = 'rimasCurrentUser';
const TOKEN_KEY = 'rimasToken';
const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:5500' : '';

let verification = null;
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
        throw new Error('Cannot reach the RIMAS server. Start it with "node server.js", then reload this page.');
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
function randomOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
function maskEmail(email) { const [name, domain] = String(email).split('@'); return `${name.slice(0, 2)}${'•'.repeat(Math.max(2, name.length - 2))}@${domain}`; }
function maskPhone(phone) { phone = String(phone); return `${phone.slice(0, 4)} ${'•'.repeat(Math.max(4, phone.length - 7))}${phone.slice(-3)}`; }
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

/* ---------- registration ---------- */
function beginRegistration() {
    const name = document.getElementById('createName').value.trim();
    const email = document.getElementById('createEmail').value.trim().toLowerCase();
    const phone = normalisePhone(`${document.getElementById('countryCode').value}${document.getElementById('createPhone').value}`);
    const password = document.getElementById('createPassword').value;
    const confirmation = document.getElementById('confirmPassword').value;

    if (!validEmail(email)) return showError('createError', 'Enter a valid email address.');
    if (phone.length < 9) return showError('createError', 'Enter a valid contact number.');
    if (password.length < 8) return showError('createError', 'Password must be at least 8 characters.');
    if (password !== confirmation) return showError('createError', 'Your password and confirmation do not match.');
    if (!document.getElementById('privacyAgreement').checked) return showError('createError', 'You must agree to the Privacy Policy to create an account.');

    // The account is only written to the database once the code is verified.
    verification = { purpose: 'register', account: { name, email, phone, password }, selectedChannel: null };
    prepareChannelPanel();
}

/* ---------- sign in ---------- */
async function beginLogin() {
    const identifier = document.getElementById('loginIdentifier').value.trim();
    const password = document.getElementById('loginPassword').value;
    setBusy(true);
    try {
        // The server checks the password against the stored hash and issues a session.
        const session = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) });
        verification = { purpose: 'login', account: session.account, session, selectedChannel: null };
        prepareChannelPanel();
    } catch (error) {
        showError('loginError', error.message);
    } finally {
        setBusy(false);
    }
}

/* ---------- password reset ---------- */
async function beginPasswordReset() {
    const identifier = document.getElementById('resetIdentifier').value.trim();
    setBusy(true);
    try {
        const contact = await api('/api/auth/contact', { method: 'POST', body: JSON.stringify({ identifier }) });
        verification = { purpose: 'reset', identifier, account: contact, selectedChannel: null };
        prepareChannelPanel();
    } catch (error) {
        showError('forgotError', error.message);
    } finally {
        setBusy(false);
    }
}

function prepareChannelPanel() {
    document.getElementById('emailDestination').textContent = maskEmail(verification.account.email);
    document.getElementById('smsDestination').textContent = maskPhone(verification.account.phone);
    document.getElementById('channelDescription').textContent = verification.purpose === 'register'
        ? 'Choose how you would like to verify your new account.'
        : 'Select where we should send your six-digit verification code.';
    showPanel('channelPanel');
}

/* ---------- one-time code ---------- */
async function sendOtp(channel) {
    if (!verification) return;
    const code = randomOtp();
    verification.selectedChannel = channel;
    verification.code = code;
    verification.expiresAt = Date.now() + 10 * 60 * 1000;
    const destinationValue = channel === 'email' ? verification.account.email : verification.account.phone;

    try {
        const payload = await api('/api/send-otp', { method: 'POST', body: JSON.stringify({ channel, destination: destinationValue, code }) });
        if (payload.testMode && payload.code) verification.code = payload.code;
    } catch (error) {
        const localTesting = window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
        if (!localTesting) return showError('channelError', error.message);
        verification.code = '123456';
        verification.expiresAt = Date.now() + 10 * 60 * 1000;
        const fallbackHint = document.getElementById('demoOtp');
        fallbackHint.hidden = false;
        fallbackHint.textContent = 'Local testing code: 123456';
    }

    document.getElementById('otpTitle').textContent = verification.purpose === 'login' ? 'Verify your sign in' : 'Enter verification code';
    const destination = channel === 'email' ? maskEmail(verification.account.email) : maskPhone(verification.account.phone);
    document.getElementById('otpDescription').textContent = `We sent a six-digit ${channel === 'email' ? 'email' : 'SMS'} code to ${destination}.`;
    document.querySelectorAll('.otp-inputs input').forEach(input => input.value = '');
    const hint = document.getElementById('demoOtp');
    const localPreview = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    hint.hidden = !localPreview;
    hint.textContent = localPreview ? `Local preview code: ${verification.code}` : '';
    showPanel('otpPanel');
    startResendTimer();
    setTimeout(() => document.querySelector('.otp-inputs input').focus(), 0);
}

function startResendTimer() {
    clearInterval(resendInterval);
    let seconds = 30;
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
function resendOtp() { if (verification?.selectedChannel) sendOtp(verification.selectedChannel); }
function cancelVerification() { verification = null; clearInterval(resendInterval); showPanel('signInPanel'); }
function enteredOtp() { return [...document.querySelectorAll('.otp-inputs input')].map(input => input.value).join(''); }

async function verifyOtp() {
    if (!verification || Date.now() > verification.expiresAt) return showError('otpError', 'This code has expired. Please request a new code.');
    if (enteredOtp() !== verification.code) return showError('otpError', 'The verification code is incorrect. Please try again.');
    clearInterval(resendInterval);

    if (verification.purpose === 'register') {
        setBusy(true);
        try {
            // Written to the server database — new sign-ups are always plain users;
            // an administrator promotes them from User Management.
            await api('/api/auth/register', { method: 'POST', body: JSON.stringify(verification.account) });
            document.getElementById('loginIdentifier').value = verification.account.email;
            document.getElementById('loginPassword').value = '';
            verification = null;
            showPanel('signInPanel');
            showError('loginError', 'Account created. You can now sign in.');
        } catch (error) {
            showPanel('createPanel');
            showError('createError', error.message);
        } finally {
            setBusy(false);
        }
        return;
    }

    if (verification.purpose === 'login') { completeLogin(verification.session); return; }
    showPanel('newPasswordPanel');
}

async function finishPasswordReset() {
    const password = document.getElementById('newPassword').value;
    const confirmation = document.getElementById('newPasswordConfirm').value;
    if (password !== confirmation) return showError('newPasswordError', 'Your password and confirmation do not match.');
    setBusy(true);
    try {
        await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ identifier: verification.identifier, password }) });
        document.getElementById('loginIdentifier').value = verification.account.email;
        document.getElementById('loginPassword').value = '';
        verification = null;
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
