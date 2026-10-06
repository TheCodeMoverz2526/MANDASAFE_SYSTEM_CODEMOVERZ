/* The MandaSafe logo screen shown while a page loads.
 *
 * Included as the FIRST element of <body> on every page, so it covers the page from the
 * first paint, before the stylesheets, Leaflet or Chart.js have arrived. It lifts once the
 * page has finished loading AND the data requests it started meanwhile (incidents, summary,
 * boundaries…) have answered, so the visitor never sees empty tables and maps. It never
 * stays longer than MAX_MS: a slow or failed request leaves the page to show its own
 * loading or error state.
 *
 * Self-contained (styles, markup and logic) so each page needs only the one <script> tag.
 */
(function () {
    const MAX_MS = 8000;     // lift no matter what after this long
    const SETTLE_MS = 150;   // lets a request that follows another (sign-in check, then data) start

    const style = document.createElement('style');
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

    const loader = document.createElement('div');
    loader.id = 'pageLoader';
    loader.setAttribute('role', 'status');
    loader.setAttribute('aria-live', 'polite');
    loader.innerHTML = '<div class="pl-mark"><div class="pl-ring"></div><img src="assets/logo-192.png" alt=""></div>'
        + '<div class="pl-text">Loading MandaSafe…</div>';
    document.body.appendChild(loader);

    let pending = 0;
    let loaded = document.readyState === 'complete';
    let done = false;
    let settleTimer = null;

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

    window.addEventListener('load', () => { loaded = true; check(); });
    setTimeout(hide, MAX_MS);

    window.PageLoader = { hide };
})();
