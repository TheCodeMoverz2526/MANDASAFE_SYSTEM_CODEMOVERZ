// Account + session storage for RIMAS.
//
// Accounts live in the SAME JSON store as incidents and prediction inputs, so an
// administrator created on the server is the same administrator every browser sees.
// Passwords are never stored — only a scrypt hash of (salt + password).
//
// Roles:
//   admin — may create/edit/delete incidents and prediction baseline data, manage users
//   user  — read-only: sees the incidents, hotspots and predictions the admins produced

const crypto = require('crypto');
const { loadStore, saveStore } = require('./db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const DEFAULT_ADMIN = {
    name: 'RIMAS Administrator',
    email: 'admin@rimas.gov.ph',
    phone: '+639171234567',
    role: 'admin',
    dept: 'Mandaluyong City TPMO',
    // Legacy Node server only (the site runs on Laravel now). No password is kept in code.
    password: process.env.MANDASAFE_ADMIN_PASSWORD || require('crypto').randomBytes(12).toString('base64url')
};

/* ---------- helpers ---------- */
function normaliseEmail(value) {
    return String(value || '').trim().toLowerCase();
}
function normalisePhone(value) {
    return String(value || '').replace(/[^+\d]/g, '').replace(/^00/, '+');
}
function randomSalt() {
    return crypto.randomBytes(16).toString('hex');
}
function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}
function initials(name) {
    return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || 'RU';
}
function avatarColor(email) {
    const colors = ['#1a56db', '#22c55e', '#f59e0b', '#7c3aed', '#0891b2', '#dc2626'];
    const hash = [...String(email)].reduce((r, ch) => ((r << 5) - r + ch.charCodeAt(0)) | 0, 0);
    return colors[Math.abs(hash) % colors.length];
}

/* Shape sent to the browser — never includes salt or passwordHash. */
function publicAccount(account) {
    if (!account) return null;
    return {
        id: account.id,
        name: account.name,
        email: account.email,
        phone: account.phone,
        role: account.role,
        dept: account.dept,
        status: account.status,
        avatar: initials(account.name),
        color: avatarColor(account.email),
        createdAt: account.createdAt,
        lastLoginAt: account.lastLoginAt || null
    };
}

/* ---------- seeding ---------- */
function seedDefaultAdmin() {
    const store = loadStore();
    if (store.accounts.some(a => a.email === DEFAULT_ADMIN.email)) return;
    const salt = randomSalt();
    store.accounts.push({
        id: `USR-${1000 + store.nextAccountSeq++}`,
        name: DEFAULT_ADMIN.name,
        email: DEFAULT_ADMIN.email,
        phone: DEFAULT_ADMIN.phone,
        role: 'admin',
        dept: DEFAULT_ADMIN.dept,
        status: 'active',
        salt,
        passwordHash: hashPassword(DEFAULT_ADMIN.password, salt),
        createdAt: new Date().toISOString(),
        lastLoginAt: null
    });
    saveStore(store);
    console.log(`Seeded default administrator: ${DEFAULT_ADMIN.email} / ${DEFAULT_ADMIN.password}`);
}

/* ---------- account operations ---------- */
function findAccount(store, identifier) {
    const email = normaliseEmail(identifier);
    const phone = normalisePhone(identifier);
    return store.accounts.find(a => a.email === email || (phone.length > 5 && a.phone === phone)) || null;
}

function accountExists(identifier) {
    return Boolean(findAccount(loadStore(), identifier));
}

function registerAccount({ name, email, phone, password, role, dept }) {
    const store = loadStore();
    const cleanEmail = normaliseEmail(email);
    const cleanPhone = normalisePhone(phone);

    if (!name || String(name).trim().length < 2) throw new Error('Enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Enter a valid email address.');
    if (cleanPhone.length < 9) throw new Error('Enter a valid contact number.');
    if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters.');
    if (store.accounts.some(a => a.email === cleanEmail)) throw new Error('An account already uses this email address.');
    if (store.accounts.some(a => a.phone === cleanPhone)) throw new Error('An account already uses this contact number.');

    // Only the very first account may claim the admin role by itself; every later admin
    // has to be promoted by an existing administrator.
    const requestedRole = role === 'admin' && store.accounts.length === 0 ? 'admin' : 'user';

    const salt = randomSalt();
    const account = {
        id: `USR-${1000 + store.nextAccountSeq++}`,
        name: String(name).trim(),
        email: cleanEmail,
        phone: cleanPhone,
        role: requestedRole,
        dept: dept || 'Mandaluyong City Resident',
        status: 'active',
        salt,
        passwordHash: hashPassword(password, salt),
        createdAt: new Date().toISOString(),
        lastLoginAt: null
    };
    store.accounts.push(account);
    saveStore(store);
    return publicAccount(account);
}

function verifyCredentials(identifier, password) {
    const store = loadStore();
    const account = findAccount(store, identifier);
    if (!account) throw new Error('Incorrect email/phone number or password.');
    if (account.status === 'inactive') throw new Error('This account has been deactivated. Contact an administrator.');
    if (!safeEqual(hashPassword(password, account.salt), account.passwordHash)) {
        throw new Error('Incorrect email/phone number or password.');
    }
    return publicAccount(account);
}

/* Used by the login page to show the masked email / phone on the OTP channel screen. */
function contactDetails(identifier) {
    const account = findAccount(loadStore(), identifier);
    if (!account) throw new Error('We could not find an account with that email address or phone number.');
    return { email: account.email, phone: account.phone, name: account.name };
}

function resetPassword(identifier, password) {
    if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters.');
    const store = loadStore();
    const account = findAccount(store, identifier);
    if (!account) throw new Error('Account not found.');
    account.salt = randomSalt();
    account.passwordHash = hashPassword(password, account.salt);
    account.updatedAt = new Date().toISOString();
    saveStore(store);
    return publicAccount(account);
}

function listAccounts() {
    return loadStore().accounts.map(publicAccount);
}

/* A signed-in account editing its own name, email or contact number from the My Account
   page. Role, status and dept stay off limits here — those remain an administrator's call
   through updateAccount(). */
function updateOwnProfile(id, changes) {
    const store = loadStore();
    const account = store.accounts.find(a => a.id === id);
    if (!account) throw new Error('User not found.');

    if (changes.name !== undefined) {
        const name = String(changes.name).trim();
        if (name.length < 2) throw new Error('Enter your full name.');
        account.name = name;
    }
    if (changes.email !== undefined) {
        const email = normaliseEmail(changes.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
        if (store.accounts.some(a => a.id !== id && a.email === email)) {
            throw new Error('An account already uses this email address.');
        }
        account.email = email;
    }
    if (changes.phone !== undefined) {
        const phone = normalisePhone(changes.phone);
        if (phone.length < 9) throw new Error('Enter a valid contact number.');
        if (store.accounts.some(a => a.id !== id && a.phone === phone)) {
            throw new Error('An account already uses this contact number.');
        }
        account.phone = phone;
    }
    account.updatedAt = new Date().toISOString();

    saveStore(store);
    return publicAccount(account);
}

function updateAccount(id, changes) {
    const store = loadStore();
    const account = store.accounts.find(a => a.id === id);
    if (!account) throw new Error('User not found.');

    if (changes.role !== undefined) {
        if (!['admin', 'user'].includes(changes.role)) throw new Error('Role must be "admin" or "user".');
        // Never let the last remaining administrator demote themselves out of the system.
        if (account.role === 'admin' && changes.role !== 'admin'
            && store.accounts.filter(a => a.role === 'admin' && a.status === 'active').length <= 1) {
            throw new Error('At least one active administrator must remain.');
        }
        account.role = changes.role;
    }
    if (changes.status !== undefined) {
        if (!['active', 'inactive'].includes(changes.status)) throw new Error('Status must be "active" or "inactive".');
        if (account.role === 'admin' && changes.status === 'inactive'
            && store.accounts.filter(a => a.role === 'admin' && a.status === 'active').length <= 1) {
            throw new Error('At least one active administrator must remain.');
        }
        account.status = changes.status;
    }
    if (changes.name) account.name = String(changes.name).trim();
    if (changes.dept) account.dept = String(changes.dept).trim();
    account.updatedAt = new Date().toISOString();

    saveStore(store);
    return publicAccount(account);
}

function deleteAccount(id) {
    const store = loadStore();
    const index = store.accounts.findIndex(a => a.id === id);
    if (index === -1) throw new Error('User not found.');
    if (store.accounts[index].role === 'admin'
        && store.accounts.filter(a => a.role === 'admin' && a.status === 'active').length <= 1) {
        throw new Error('At least one active administrator must remain.');
    }
    store.accounts.splice(index, 1);
    store.sessions = store.sessions.filter(s => s.accountId !== id);
    saveStore(store);
    return { deleted: id };
}

/* ---------- sessions ---------- */
function pruneSessions(store) {
    const now = Date.now();
    store.sessions = store.sessions.filter(s => new Date(s.expiresAt).getTime() > now);
}

function createSession(accountId) {
    const store = loadStore();
    pruneSessions(store);
    const account = store.accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found.');
    const token = crypto.randomBytes(24).toString('hex');
    store.sessions.push({
        token,
        accountId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    });
    account.lastLoginAt = new Date().toISOString();
    saveStore(store);
    return { token, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), account: publicAccount(account) };
}

function destroySession(token) {
    const store = loadStore();
    store.sessions = store.sessions.filter(s => s.token !== token);
    saveStore(store);
}

/* Returns the public account behind a token, or null. */
function accountForToken(token) {
    if (!token) return null;
    const store = loadStore();
    pruneSessions(store);
    const session = store.sessions.find(s => s.token === token);
    if (!session) return null;
    const account = store.accounts.find(a => a.id === session.accountId);
    if (!account || account.status === 'inactive') return null;
    return publicAccount(account);
}

/* Reads the token from an Authorization: Bearer header or an x-rimas-token header. */
function tokenFromRequest(request) {
    const header = request.headers['authorization'] || '';
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    return request.headers['x-rimas-token'] || null;
}

module.exports = {
    seedDefaultAdmin, registerAccount, verifyCredentials, contactDetails, resetPassword,
    listAccounts, updateAccount, updateOwnProfile, deleteAccount, accountExists,
    createSession, destroySession, accountForToken, tokenFromRequest, publicAccount,
    DEFAULT_ADMIN
};
