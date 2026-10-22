/* =========================================================
   MandaSafe — homepage Announcement and Insight cards
   Announcements are posted by the TPMO from the RIMAS console (road closures, reroutes and
   warnings, with photos). Insights are written by the server from the accident records —
   citywide findings first, then one report per barangay — so they change with the data.

   Each card is a small carousel; a slide opens its full details, and "See more" lists them
   all. Details can be linked to directly: index.html#announcement-12, #insight-brgy-hulo.
   Needs icon(), esc(), num() and fmtDate() from app.js.
   ========================================================= */

const ANN_CATEGORY = {
  closure: { label: 'Road Closure', icon: 'ban',   cls: 'cat-closure' },
  reroute: { label: 'Rerouting',    icon: 'route', cls: 'cat-reroute' },
  warning: { label: 'Road Warning', icon: 'alert', cls: 'cat-warning' }
};
const ANN_STATE = { active: 'In effect', upcoming: 'Upcoming', ended: 'Ended' };
const INS_LEVEL = {
  alert: { label: 'Needs attention', cls: 'lv-alert' },
  watch: { label: 'Keep watch',      cls: 'lv-watch' },
  good:  { label: 'Low risk',        cls: 'lv-good' },
  info:  { label: 'Good to know',    cls: 'lv-info' }
};
const ACTION_STATUS = { planned: 'Planned', ongoing: 'Ongoing', completed: 'Completed' };
const SLIDE_MS = 8000;
const CAROUSEL_INSIGHTS = 12;

const ux = { announcements: [], insights: [], generatedFrom: null, opener: null };

/* ---------------- formatting ---------------- */
function fmtWhen(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtSchedule(a) {
  return a.endsAt ? `${fmtWhen(a.startsAt)} – ${fmtWhen(a.endsAt)}` : `From ${fmtWhen(a.startsAt)} until further notice`;
}
function fmtMonthLong(key) {
  if (!key) return '';
  const [y, m] = key.split('-');
  return new Date(+y, +m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
// Typed text keeps its paragraphs and line breaks, and nothing else.
function paragraphs(text) {
  return String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/* ---------------- charts (inline SVG) ----------------
   line: a monthly series; the highlighted point is ringed, and a forecast tail is dashed.
   bars: vertical bars, the highlighted one in orange. hbars: labelled horizontal rows.
   mini: the faint chart drawn behind a carousel slide — no text, stretched to fit. */
function insightChart(c, mini) {
  if (!c || !c.values || !c.values.length) return '';
  if (c.kind === 'hbars' && !mini) {
    const max = c.max || Math.max(...c.values, 1);
    return `<ol class="ux-hbars">${c.values.map((v, i) => `
      <li class="${i === c.highlight ? 'hl' : ''}"><span>${esc(c.labels[i])}</span>
        <i><i style="width:${Math.max(2, v / max * 100)}%"></i></i><b>${num(v)}</b></li>`).join('')}</ol>`;
  }

  const W = 600, H = mini ? 140 : 210, padX = mini ? 0 : 14, top = mini ? 12 : 26, bottom = mini ? 0 : 28;
  const n = c.values.length, max = Math.max(...c.values, 1);
  const y = v => top + (H - top - bottom) * (1 - v / max);
  const attrs = `viewBox="0 0 ${W} ${H}" ${mini ? 'preserveAspectRatio="none"' : ''} class="ux-chart${mini ? ' mini' : ''}" role="img" aria-label="${esc(c.title || '')}"`;
  const every = n > 12 ? Math.ceil(n / 8) : 1;
  let body = '';

  if (c.kind === 'line') {
    const x = i => padX + (W - 2 * padX) * (n === 1 ? 0.5 : i / (n - 1));
    const pts = c.values.map((v, i) => [x(i), y(v)]);
    const path = list => list.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const split = c.forecastFrom ?? n;
    const solid = pts.slice(0, split), dashed = pts.slice(Math.max(0, split - 1));
    body += `<path class="ux-area" d="${path(solid)} L${solid[solid.length - 1][0]} ${H - bottom} L${solid[0][0]} ${H - bottom}Z"/>`;
    body += `<path class="ln" d="${path(solid)}"/>`;
    if (split < n) body += `<path class="ln fc" d="${path(dashed)}"/>`;
    if (!mini) {
      body += pts.map((p, i) => `<circle class="pt${i >= split ? ' fc' : ''}" cx="${p[0]}" cy="${p[1]}" r="${i === c.highlight ? 6 : 3.5}"><title>${esc(c.labels[i])}: ${num(c.values[i])}</title></circle>`).join('');
      if (c.highlight != null) body += `<text class="val" x="${pts[c.highlight][0]}" y="${pts[c.highlight][1] - 12}" text-anchor="middle">${num(c.values[c.highlight])}</text>`;
      body += c.labels.map((l, i) => i % every && i !== n - 1 ? '' : `<text class="lbl" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`).join('');
      if (split < n) body += `<text class="lbl fc" x="${x(split)}" y="${top - 10}" text-anchor="middle">forecast →</text>`;
    }
  } else {
    const slot = (W - 2 * padX) / n, bw = Math.max(2, slot * 0.68);
    body += c.values.map((v, i) => {
      const bx = padX + slot * i + (slot - bw) / 2, by = y(v);
      return `<rect class="ux-bar${i === c.highlight ? ' hl' : ''}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - bottom - by).toFixed(1)}" rx="${mini ? 1 : 3}"><title>${esc(c.labels[i])}: ${num(v)}</title></rect>`
        + (mini || (i % every && i !== c.highlight) ? '' : `<text class="lbl" x="${(bx + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(c.labels[i])}</text>`);
    }).join('');
    if (!mini && c.highlight != null) {
      const bx = padX + slot * c.highlight + slot / 2;
      body += `<text class="val" x="${bx}" y="${y(c.values[c.highlight]) - 8}" text-anchor="middle">${num(c.values[c.highlight])}</text>`;
    }
  }
  return `<svg ${attrs}>${body}</svg>`;
}

/* ---------------- slides ---------------- */
function annVisual(a, cls = '') {
  const cat = ANN_CATEGORY[a.category] || ANN_CATEGORY.warning;
  return a.photos.length
    ? `<img class="ux-photo ${cls}" src="${esc(a.photos[0].url)}" alt="${esc(a.photos[0].caption || a.title)}" loading="lazy">`
    : `<div class="ux-noimg ${cat.cls} ${cls}">${icon(cat.icon)}</div>`;
}
function annSlide(a, i) {
  const cat = ANN_CATEGORY[a.category] || ANN_CATEGORY.warning;
  return `<button type="button" class="ux-slide ux-slide-ann ${cat.cls}" data-open="ann" data-id="${a.id}" data-n="${i}"
      aria-label="${esc(cat.label)}: ${esc(a.title)} — view details">
    ${annVisual(a)}
    <span class="ux-shade"></span>
    <span class="ux-tags"><span class="ux-tag ${cat.cls}">${icon(cat.icon)}${esc(cat.label)}</span>
      <span class="ux-tag st-${a.state}">${ANN_STATE[a.state] || ''}</span>
      ${a.photos.length > 1 ? `<span class="ux-tag ux-tag-ghost">${icon('image')}${a.photos.length}</span>` : ''}</span>
    <span class="ux-cap"><b>${esc(a.title)}</b><small>${icon('pin')}${esc(a.location)}${a.barangay ? ` · ${esc(a.barangay)}` : ''}</small>
      <small>${icon('clock')}${esc(fmtSchedule(a))}</small></span>
  </button>`;
}
function insSlide(s, i) {
  const lv = INS_LEVEL[s.level] || INS_LEVEL.info;
  return `<button type="button" class="ux-slide ux-slide-ins ${lv.cls}" data-open="ins" data-id="${esc(s.id)}" data-n="${i}"
      aria-label="${esc(s.title)} — view details">
    <span class="ux-insbg">${insightChart(s.charts[0], true)}</span>
    <span class="ux-tags"><span class="ux-tag ux-tag-glass">${icon(s.scope === 'city' ? 'shield' : 'pin')}${esc(s.scope === 'city' ? 'Mandaluyong' : s.barangay)}</span>
      <span class="ux-tag ${lv.cls}">${lv.label}</span></span>
    <span class="ux-cap"><small class="ux-topic">${esc(s.topic)}</small><b>${esc(s.title)}</b><small>${esc(s.headline)}</small></span>
  </button>`;
}

/* ---------------- carousel ---------------- */
function carousel(cardId, slides, emptyHtml) {
  const card = document.getElementById(cardId);
  const track = card.querySelector('.ux-track'), dots = card.querySelector('.ux-dots');
  const prev = card.querySelector('.ux-prev'), next = card.querySelector('.ux-next');
  let at = 0, timer = null;

  track.innerHTML = slides.length ? slides.join('') : `<div class="ux-empty">${emptyHtml}</div>`;
  const items = [...track.querySelectorAll('.ux-slide')];
  prev.hidden = next.hidden = items.length < 2;
  dots.innerHTML = items.length < 2 ? '' : items.map((_, i) =>
    `<button type="button" role="tab" aria-label="Slide ${i + 1} of ${items.length}" data-n="${i}"></button>`).join('');
  const dotEls = [...dots.children];

  function show(n) {
    if (!items.length) return;
    at = (n + items.length) % items.length;
    items.forEach((el, i) => { el.classList.toggle('on', i === at); el.tabIndex = i === at ? 0 : -1; el.setAttribute('aria-hidden', String(i !== at)); });
    dotEls.forEach((d, i) => d.setAttribute('aria-selected', String(i === at)));
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function play() {
    clearInterval(timer);
    if (!reduced && items.length > 1) timer = setInterval(() => { if (!document.body.classList.contains('ux-open')) show(at + 1); }, SLIDE_MS);
  }

  prev.onclick = () => { show(at - 1); play(); };
  next.onclick = () => { show(at + 1); play(); };
  dotEls.forEach(d => d.addEventListener('click', () => { show(+d.dataset.n); play(); }));
  card.onmouseenter = card.onfocusin = () => clearInterval(timer);
  card.onmouseleave = card.onfocusout = play;
  card.onkeydown = e => {
    if (e.key === 'ArrowLeft') { show(at - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { show(at + 1); e.preventDefault(); }
  };
  // Swipe on phones: a mostly sideways drag of 40px turns the slide instead of opening it.
  let x0 = null, y0 = 0, swiped = false;
  track.onpointerdown = e => { x0 = e.clientX; y0 = e.clientY; swiped = false; };
  track.onpointerup = e => {
    if (x0 === null) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { swiped = true; show(at + (dx < 0 ? 1 : -1)); play(); }
    x0 = null;
  };
  track.onclick = e => {
    const slide = e.target.closest('.ux-slide');
    if (!slide || swiped) return;
    openDetail(slide.dataset.open, slide.dataset.id, slide);
  };
  show(0);
  play();
}

/* ---------------- modals ---------------- */
function openModal(id, opener) {
  if (!document.body.classList.contains('ux-open')) ux.opener = opener || document.activeElement;
  document.querySelectorAll('.ux-modal').forEach(m => { if (m.id !== id) m.hidden = true; });
  const modal = document.getElementById(id);
  modal.hidden = false;
  modal.querySelector('.ux-sheet').scrollTop = 0;
  document.body.classList.add('ux-open');
  modal.querySelector('.ux-close').focus();
}
function closeModals() {
  document.querySelectorAll('.ux-modal').forEach(m => { m.hidden = true; });
  document.body.classList.remove('ux-open');
  if (/^#(announcement|insight)-/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  if (ux.opener && document.contains(ux.opener)) ux.opener.focus();
  ux.opener = null;
}
document.addEventListener('click', e => {
  if (e.target.matches('.ux-modal') || e.target.closest('.ux-modal [data-close]')) closeModals();
  const more = e.target.closest('[data-more]');
  if (more) openList(more.dataset.more, more);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('uxLightbox').hidden) closeLightbox();
  else if (document.body.classList.contains('ux-open')) closeModals();
});

function openDetail(kind, id, opener) {
  const body = document.getElementById('uxDetailBody');
  if (kind === 'ann') {
    const a = ux.announcements.find(x => String(x.id) === String(id));
    if (!a) return;
    body.innerHTML = annDetail(a);
    setUpGallery(body, a);
    history.replaceState(null, '', `#announcement-${a.id}`);
  } else {
    const s = ux.insights.find(x => x.id === id);
    if (!s) return;
    body.innerHTML = insDetail(s);
    history.replaceState(null, '', `#insight-${s.id}`);
  }
  body.querySelector('[data-map]')?.addEventListener('click', e => showOnMap(e.currentTarget.dataset.map));
  body.querySelector('[data-copy]')?.addEventListener('click', e => copyLink(e.currentTarget));
  openModal('uxDetail', opener);
}

function detailActions(barangay) {
  return `<div class="ux-actions">
    ${barangay ? `<button type="button" class="btn btn-primary" data-map="${esc(barangay)}">${icon('map')}Show ${esc(barangay)} on the map</button>` : ''}
    <button type="button" class="btn btn-ghost" data-copy>${icon('copy')}<span>Copy link</span></button>
  </div>`;
}

function annDetail(a) {
  const cat = ANN_CATEGORY[a.category] || ANN_CATEGORY.warning;
  const many = a.photos.length > 1;
  return `
    <div class="ux-gallery ${cat.cls}">
      ${a.photos.length ? `<button type="button" class="ux-gal-main" aria-label="View photo at full size">
          <img src="${esc(a.photos[0].url)}" alt="${esc(a.photos[0].caption || a.title)}"><span class="ux-zoom">${icon('expand')}</span></button>
        ${many ? `<button type="button" class="ux-nav ux-prev" aria-label="Previous photo">${icon('chevL')}</button>
          <button type="button" class="ux-nav ux-next" aria-label="Next photo">${icon('chevR')}</button>` : ''}
        <p class="ux-gal-cap"${a.photos[0].caption ? '' : ' hidden'}>${esc(a.photos[0].caption || '')}</p>`
      : `<div class="ux-noimg ${cat.cls}">${icon(cat.icon)}<small>No photo attached</small></div>`}
    </div>
    ${many ? `<div class="ux-thumbs">${a.photos.map((p, i) => `<button type="button" data-n="${i}" aria-label="Photo ${i + 1}"${i ? '' : ' class="on"'}>
        <img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
    <div class="ux-detail-in">
      <div class="ux-tags-row"><span class="ux-tag ${cat.cls}">${icon(cat.icon)}${cat.label}</span>
        <span class="ux-tag st-${a.state}">${ANN_STATE[a.state] || ''}</span></div>
      <h2 id="uxDetailTitle">${esc(a.title)}</h2>
      <p class="ux-lead">${esc(a.summary)}</p>
      <div class="ux-facts">
        <div><span>${icon('pin')}Road / area</span><b>${esc(a.location)}</b></div>
        <div><span>${icon('map')}Barangay</span><b>${esc(a.barangay || 'Citywide')}</b></div>
        <div><span>${icon('calendar')}Starts</span><b>${esc(fmtWhen(a.startsAt))}</b></div>
        <div><span>${icon('clock')}Ends</span><b>${esc(a.endsAt ? fmtWhen(a.endsAt) : 'Until further notice')}</b></div>
      </div>
      ${a.reroute ? `<div class="ux-callout">${icon('route')}<div><b>${a.category === 'warning' ? 'Suggested route' : 'Alternate route'}</b>${paragraphs(a.reroute)}</div></div>` : ''}
      <h3>Full details</h3>
      <div class="ux-text">${paragraphs(a.details)}</div>
      <p class="ux-foot">Posted by the Mandaluyong City TPMO on ${esc(fmtWhen(a.createdAt))}${a.updatedAt ? ` · updated ${esc(fmtWhen(a.updatedAt))}` : ''}.</p>
      ${detailActions(a.barangay)}
    </div>`;
}

function insDetail(s) {
  const lv = INS_LEVEL[s.level] || INS_LEVEL.info;
  const g = ux.generatedFrom;
  return `
    <div class="ux-detail-in">
      <div class="ux-tags-row"><span class="ux-tag ux-tag-soft">${icon(s.scope === 'city' ? 'shield' : 'pin')}${esc(s.scope === 'city' ? 'Mandaluyong City' : s.barangay)}</span>
        <span class="ux-tag ux-tag-soft">${esc(s.topic)}</span><span class="ux-tag ${lv.cls}">${lv.label}</span></div>
      <h2 id="uxDetailTitle">${esc(s.title)}</h2>
      <p class="ux-lead">${esc(s.headline)}</p>
      <div class="ux-text"><p>${esc(s.body)}</p></div>
      <div class="ux-stats">${s.stats.map(x => `<div><span>${esc(x.label)}</span><b>${esc(x.value)}</b></div>`).join('')}</div>
      ${s.charts.map(c => `<figure class="ux-fig"><figcaption>${esc(c.title)}</figcaption>${insightChart(c, false)}</figure>`).join('')}
      ${(s.causes || []).length ? `
      <h3>${icon('search')}Why this happens</h3>
      <p class="ux-note">The accident records say when and where each accident happened, not why. These are the common reasons behind this pattern.</p>
      <ol class="ux-causes">${s.causes.map(c => `<li><b>${esc(c.title)}</b><span>${esc(c.text)}</span></li>`).join('')}</ol>` : ''}
      <h3>${icon('bulb')}Possible solutions</h3>
      <div class="ux-solutions">
        ${(s.solutions || []).length ? `<div class="ux-sol ux-sol-city"><b>${icon('shield')}What the TPMO and the city can do</b><ul>${s.solutions.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
        ${s.tips.length ? `<div class="ux-sol ux-sol-you"><b>${icon('user')}What you can do</b><ul>${s.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
      </div>
      <h3>${icon('clipboard')}What the TPMO / LGU is doing</h3>
      ${(s.actions || []).length ? `<ol class="ux-actions-list">${s.actions.map(a => `
        <li class="act-${esc(a.status)}"><span class="ux-act-dot"></span>
          <div><div class="ux-act-head"><span class="ux-act-status">${esc(ACTION_STATUS[a.status] || a.status)}</span>${a.date ? `<small>${esc(fmtDate(a.date))}</small>` : ''}</div>
            <b>${esc(a.title)}</b><div class="ux-act-text">${paragraphs(a.details)}</div></div></li>`).join('')}</ol>`
        : `<div class="ux-act-empty">${icon('clock')}<span>The TPMO has not posted an action for this yet. Actions taken by the city will be listed here.</span></div>`}
      <p class="ux-foot">Written automatically from ${g ? `${num(g.records)} accident records, ${esc(fmtMonthLong(g.from))} – ${esc(fmtMonthLong(g.to))}` : 'the accident records'}.
        It updates by itself when the TPMO adds new records.</p>
      ${detailActions(s.barangay)}
    </div>`;
}

function setUpGallery(root, a) {
  if (!a.photos.length) return;
  let at = 0;
  const img = root.querySelector('.ux-gal-main img'), cap = root.querySelector('.ux-gal-cap');
  const thumbs = [...root.querySelectorAll('.ux-thumbs button')];
  const show = n => {
    at = (n + a.photos.length) % a.photos.length;
    img.src = a.photos[at].url;
    img.alt = a.photos[at].caption || a.title;
    cap.textContent = a.photos[at].caption || '';
    cap.hidden = !a.photos[at].caption;
    thumbs.forEach((t, i) => t.classList.toggle('on', i === at));
  };
  root.querySelector('.ux-gallery .ux-prev')?.addEventListener('click', () => show(at - 1));
  root.querySelector('.ux-gallery .ux-next')?.addEventListener('click', () => show(at + 1));
  thumbs.forEach(t => t.addEventListener('click', () => show(+t.dataset.n)));
  root.querySelector('.ux-gal-main').addEventListener('click', () => openLightbox(a.photos, at));
}

/* ---------------- photo viewer ---------------- */
const lightbox = { photos: [], at: 0 };
function openLightbox(photos, at) {
  lightbox.photos = photos;
  const box = document.getElementById('uxLightbox');
  box.querySelectorAll('.ux-nav').forEach(b => { b.hidden = photos.length < 2; });
  showLightbox(at);
  box.hidden = false;
  box.querySelector('.ux-close').focus();
}
function showLightbox(n) {
  const p = lightbox.photos;
  lightbox.at = (n + p.length) % p.length;
  document.getElementById('uxLightboxImg').src = p[lightbox.at].url;
  document.getElementById('uxLightboxImg').alt = p[lightbox.at].caption || 'Announcement photo';
  document.getElementById('uxLightboxCap').textContent =
    `${p[lightbox.at].caption || ''}${p.length > 1 ? `  (${lightbox.at + 1} of ${p.length})` : ''}`.trim();
}
function closeLightbox() {
  document.getElementById('uxLightbox').hidden = true;
  document.querySelector('#uxDetail .ux-gal-main')?.focus();
}
(() => {
  const box = document.getElementById('uxLightbox');
  box.querySelector('.ux-close').addEventListener('click', closeLightbox);
  box.querySelector('.ux-prev').addEventListener('click', () => showLightbox(lightbox.at - 1));
  box.querySelector('.ux-next').addEventListener('click', () => showLightbox(lightbox.at + 1));
  box.addEventListener('click', e => { if (e.target === box) closeLightbox(); });
  box.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') showLightbox(lightbox.at - 1);
    if (e.key === 'ArrowRight') showLightbox(lightbox.at + 1);
  });
})();

/* ---------------- "See more" lists ---------------- */
function openList(kind, opener) {
  const title = document.getElementById('uxListTitle'), sub = document.getElementById('uxListSub');
  const filters = document.getElementById('uxListFilters'), body = document.getElementById('uxListBody');
  const chips = (name, options) => `<div class="ux-chips" data-group="${name}">${options.map(([v, l], i) =>
    `<button type="button" data-v="${v}" aria-pressed="${!i}"${i ? '' : ' class="on"'}>${l}</button>`).join('')}</div>`;

  if (kind === 'ann') {
    title.textContent = 'Road Announcements';
    sub.textContent = 'Road closures, reroutes and warnings posted by the Mandaluyong City TPMO.';
    filters.innerHTML = chips('cat', [['', 'All'], ['closure', 'Road Closure'], ['reroute', 'Rerouting'], ['warning', 'Road Warning']])
      + chips('when', [['current', 'In effect & upcoming'], ['all', 'Include ended']]);
  } else {
    title.textContent = 'Road Safety Insights';
    sub.textContent = 'Findings for Mandaluyong and each of its barangays, written from the accident records.';
    filters.innerHTML = chips('scope', [['', 'All'], ['city', 'Citywide'], ['barangay', 'By barangay']])
      + `<label class="ux-search">${icon('search')}<input type="search" placeholder="Find a barangay…" aria-label="Find a barangay"></label>`;
  }

  const state = {};
  const render = () => {
    const q = (filters.querySelector('input')?.value || '').trim().toLowerCase();
    const rows = kind === 'ann'
      ? ux.announcements.filter(a => (!state.cat || a.category === state.cat) && (state.when === 'all' || a.state !== 'ended'))
      : ux.insights.filter(s => (!state.scope || s.scope === state.scope)
          && (!q || (s.barangay || 'mandaluyong citywide').toLowerCase().includes(q) || s.title.toLowerCase().includes(q)));
    body.innerHTML = rows.map(kind === 'ann' ? annRow : insRow).join('')
      || `<div class="ux-empty">${kind === 'ann' ? 'No announcements match this filter.' : 'No insights match this search.'}</div>`;
  };
  filters.querySelectorAll('.ux-chips').forEach(group => {
    state[group.dataset.group] = group.querySelector('.on').dataset.v;
    group.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      group.querySelectorAll('button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      state[group.dataset.group] = b.dataset.v;
      render();
    });
  });
  filters.querySelector('input')?.addEventListener('input', render);
  body.onclick = e => {
    const row = e.target.closest('[data-open]');
    if (row) openDetail(row.dataset.open, row.dataset.id, opener);
  };
  render();
  openModal('uxList', opener);
}
function annRow(a) {
  const cat = ANN_CATEGORY[a.category] || ANN_CATEGORY.warning;
  return `<button type="button" class="ux-row" data-open="ann" data-id="${a.id}">
    <span class="ux-row-vis">${annVisual(a)}</span>
    <span class="ux-row-body">
      <span class="ux-tags-row"><span class="ux-tag ${cat.cls}">${icon(cat.icon)}${cat.label}</span><span class="ux-tag st-${a.state}">${ANN_STATE[a.state] || ''}</span></span>
      <b>${esc(a.title)}</b>
      <small>${icon('pin')}${esc(a.location)}${a.barangay ? ` · ${esc(a.barangay)}` : ''} &nbsp; ${icon('clock')}${esc(fmtSchedule(a))}</small>
      <span class="ux-row-sum">${esc(a.summary)}</span>
    </span>
    <span class="ux-row-go">${icon('chevR')}</span></button>`;
}
function insRow(s) {
  const lv = INS_LEVEL[s.level] || INS_LEVEL.info;
  return `<button type="button" class="ux-row" data-open="ins" data-id="${esc(s.id)}">
    <span class="ux-row-vis ux-row-ins ${lv.cls}">${insightChart(s.charts[0], true)}</span>
    <span class="ux-row-body">
      <span class="ux-tags-row"><span class="ux-tag ux-tag-soft">${esc(s.scope === 'city' ? 'Mandaluyong' : s.barangay)}</span>
        <span class="ux-tag ux-tag-soft">${esc(s.topic)}</span><span class="ux-tag ${lv.cls}">${lv.label}</span></span>
      <b>${esc(s.title)}</b>
      <span class="ux-row-sum">${esc(s.headline)}</span>
    </span>
    <span class="ux-row-go">${icon('chevR')}</span></button>`;
}

/* ---------------- actions ---------------- */
// Picks the barangay in the map's own filter, so the map, pins and figures all follow.
function showOnMap(barangay) {
  closeModals();
  const select = document.getElementById('fBarangay');
  const option = [...select.options].find(o => o.value.toLowerCase() === barangay.toLowerCase());
  if (option && !document.getElementById('heroFilters').hidden) {
    select.value = option.value;
    select.dispatchEvent(new Event('change'));
  }
  document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function copyLink(btn) {
  const label = btn.querySelector('span');
  try { await navigator.clipboard.writeText(location.href); label.textContent = 'Link copied'; }
  catch { label.textContent = 'Copy the address bar'; }
  setTimeout(() => { label.textContent = 'Copy link'; }, 2200);
}

/* ---------------- load ---------------- */
(async () => {
  const [ann, ins] = await Promise.allSettled([apiGet('/api/announcements'), apiGet('/api/insights')]);

  if (ann.status === 'fulfilled') {
    // In effect first, then upcoming (soonest first); ended ones only appear under See more.
    const order = { active: 0, upcoming: 1, ended: 2 };
    ux.announcements = ann.value.sort((a, b) => order[a.state] - order[b.state]
      || (a.state === 'upcoming' ? a.startsAt.localeCompare(b.startsAt) : b.startsAt.localeCompare(a.startsAt)));
    const current = ux.announcements.filter(a => a.state !== 'ended');
    carousel('annCard', current.map(annSlide),
      `${icon('check')}<b>No road advisories right now</b><small>Closures, reroutes and warnings from the TPMO will appear here.</small>`);
  } else {
    carousel('annCard', [], `${icon('alert')}<b>Announcements could not be loaded</b><small>${esc(ann.reason.message)}</small>`);
  }

  if (ins.status === 'fulfilled') {
    ux.insights = ins.value.insights;
    ux.generatedFrom = ins.value.generatedFrom;
    // The carousel shows the citywide findings and the barangays that need attention.
    const featured = ux.insights.filter(s => s.scope === 'city' || ['alert', 'watch'].includes(s.level)).slice(0, CAROUSEL_INSIGHTS);
    carousel('insCard', featured.map(insSlide), `${icon('chart')}<b>No insights yet</b><small>They appear once accident records are added.</small>`);
  } else {
    carousel('insCard', [], `${icon('alert')}<b>Insights could not be loaded</b><small>${esc(ins.reason.message)}</small>`);
  }

  const link = location.hash.match(/^#(announcement|insight)-(.+)$/);
  if (link) openDetail(link[1] === 'announcement' ? 'ann' : 'ins', decodeURIComponent(link[2]));
})();
