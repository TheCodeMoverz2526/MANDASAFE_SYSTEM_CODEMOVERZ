/* The MandaSafe logo screen, shown only while an administrator signs in.
 *
 * login.html calls PageLoader.signInHandover() once the authenticator code is accepted: the
 * screen ("Signing you in…") covers the login page while the browser moves on, and a one-time
 * flag in sessionStorage tells the admin console to keep it up ("Loading MandaSafe…") until its
 * data has arrived. Opening, reloading or moving between pages never shows it — the flag is
 * consumed on the first console load after signing in.
 *
 * Included as the FIRST element of <body> on login.html and Mandasafe.html, so on the console
 * it covers the page from the first paint. It lifts once the page's HTML and scripts are in
 * AND the data requests it started meanwhile (incidents, notifications…) have answered, and
 * never later than MAX_MS: a slow or failed request leaves the console to show its own
 * loading or error state.
 *
 * Self-contained (styles, markup and logic) so each page needs only the one <script> tag.
 */
(function () {
    const MAX_MS = 3000;     // lift no matter what after this long
    const SETTLE_MS = 150;   // lets a request that follows another (sign-in check, then data) start
    const FLAG = 'mandasafeAdminSignIn';

    let style = null;
    function addStyles() {
        if (style) return;
        style = document.createElement('style');
        style.textContent = `
            #pageLoader {
                position: fixed; inset: 0; z-index: 2147483000;
                display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
                background: #f4f7fc;
                font: 600 14px/1.4 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif;
                color: #062350;
                transition: opacity .35s ease, visibility .35s ease;
                /* Failsafe if this script stops running: the screen still fades on its own. */
                animation: pageLoaderFailsafe .35s ease ${MAX_MS + 2000}ms forwards;
            }
            #pageLoader.is-hidden { opacity: 0; visibility: hidden; pointer-events: none; }
            #pageLoader.is-held { animation: none; }
            #pageLoader .pl-mark { position: relative; width: 112px; height: 112px; display: grid; place-items: center; }
            #pageLoader .pl-mark img { width: 84px; height: 84px; object-fit: contain; animation: pageLoaderPulse 1.6s ease-in-out infinite; }
            #pageLoader .pl-ring {
                position: absolute; inset: 0; border-radius: 50%;
                border: 3px solid rgba(29, 78, 216, .15); border-top-color: #1d4ed8;
                animation: pageLoaderSpin .9s linear infinite;
            }
            #pageLoader .pl-text { letter-spacing: .02em; opacity: .8; }
            @keyframes pageLoaderSpin { to { transform: rotate(360deg); } }
            @keyframes pageLoaderPulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(.94); } }
            @keyframes pageLoaderFailsafe { to { opacity: 0; visibility: hidden; pointer-events: none; } }
            @media (prefers-reduced-motion: reduce) {
                #pageLoader .pl-ring, #pageLoader .pl-mark img { animation: none; }
            }`;
        document.head.appendChild(style);
    }

    function createLoader(text) {
        addStyles();
        const el = document.createElement('div');
        el.id = 'pageLoader';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.innerHTML = '<div class="pl-mark"><div class="pl-ring"></div><img src="assets/logo-192.png" alt=""></div>'
            + '<div class="pl-text"></div>';
        el.querySelector('.pl-text').textContent = text;
        document.body.appendChild(el);
        return el;
    }

    /* On the login page: cover it while the browser moves to the console, and tell the
       console to keep the screen up until it has loaded. Held: no failsafe fade, since the
       page is about to be replaced anyway. */
    function signInHandover() {
        try { sessionStorage.setItem(FLAG, '1'); } catch { /* the console just won't show it */ }
        if (!document.getElementById('pageLoader')) createLoader('Signing you in…').classList.add('is-held');
    }

    window.PageLoader = { signInHandover };

    // Only the first page load straight after an administrator signed in shows the screen.
    let justSignedIn = false;
    try {
        justSignedIn = sessionStorage.getItem(FLAG) === '1';
        sessionStorage.removeItem(FLAG);
    } catch { /* storage blocked: no screen */ }
    if (!justSignedIn) return;

    const loader = createLoader('Loading MandaSafe…');
    let pending = 0;
    let loaded = document.readyState !== 'loading';
    let done = false;
    let settleTimer = null;

    // Count the requests made while the screen is up; the page is ready when they have answered.
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        const request = originalFetch.apply(this, args);
        if (done) return request;
        pending++;
        const settle = () => { pending--; check(); };
        // fetch() resolves when the headers arrive; on a slow connection the body (the
        // incidents list is ~130 KB gzipped) takes seconds more, so wait for it on a copy.
        request.then(response => response.clone().arrayBuffer().then(settle, settle), settle);
        return request;
    };

    function hide() {
        if (done) return;
        done = true;
        window.fetch = originalFetch;
        loader.classList.add('is-hidden');
        setTimeout(() => { loader.remove(); style.remove(); }, 400);
    }

    function check() {
        clearTimeout(settleTimer);
        if (loaded && pending === 0) settleTimer = setTimeout(() => { if (pending === 0) hide(); }, SETTLE_MS);
    }

    // DOMContentLoaded, not load: by then the console's scripts have run and started their data
    // requests. The full load event also waits for the icon font and the map tiles, none of
    // which the administrator needs to wait behind the logo for.
    document.addEventListener('DOMContentLoaded', () => { loaded = true; check(); });
    setTimeout(hide, MAX_MS);
})();
