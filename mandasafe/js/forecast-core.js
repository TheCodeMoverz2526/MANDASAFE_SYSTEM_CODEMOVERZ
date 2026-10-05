/* Shared forecast logic for the resident Forecast page (forecast.html) and the admin console's
   Accident Forecast page (Mandasafe.html / script.js), so both show the same numbers and the
   same explanations.

   The server (/api/predictions) sends, per area, a recursive month-by-month forecast
   (forecastMonths + forecastPath, up to 24 months ahead) and the exact figures behind its trend
   label and risk score (`explain`). This file turns a chosen date window into totals, labels,
   chart series, the filter bar and the "why this prediction" dialog.

   Usage:
     const model = ForecastCore.create(predictions);
     const state = model.restoreState('storage-key');
     ForecastCore.mountFilters(containerEl, model, state, () => render());
     const v = model.view(state);        // everything a page needs to draw itself
     ForecastCore.openDetail(model, row, v);
*/
(function () {
    'use strict';

    /* ---------------- small helpers ---------------- */
    const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
    const num = value => Number(value || 0).toLocaleString();
    const r1 = v => Math.round(v * 10) / 10;
    const r2 = v => Math.round(v * 100) / 100;
    const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
    const mean = list => (list.length ? list.reduce((a, v) => a + v, 0) / list.length : 0);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    const addMonths = (key, k) => {
        const [y, m] = String(key).split('-').map(Number);
        const i = y * 12 + (m - 1) + k;
        return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`;
    };
    const monthIdx = key => { const [y, m] = String(key).split('-').map(Number); return y * 12 + m - 1; };
    const daysIn = key => { const [y, m] = String(key).split('-').map(Number); return new Date(y, m, 0).getDate(); };
    const firstDay = key => `${key}-01`;
    const lastDay = key => `${key}-${String(daysIn(key)).padStart(2, '0')}`;
    const shortMonth = key => {
        if (!key) return '—';
        const [y, m] = String(key).split('-');
        return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    };
    const longMonth = key => {
        if (!key) return '—';
        const [y, m] = String(key).split('-').map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    };
    const shortDate = iso => {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

    const TREND_ICON = { up: '▲', down: '▼', stable: '■' };
    const TREND_COLOR = { up: '#dc2626', down: '#16a34a', stable: '#64748b' };
    const RISK_NAME = { high: 'High', medium: 'Moderate', low: 'Low' };
    const HORIZONS = [[1, 'Next month'], [3, 'Next 3 months'], [6, 'Next 6 months'], [12, 'Next 12 months']];

    /* ---------------- the model ---------------- */
    function create(predictions) {
        const first = predictions[0] || null;
        const usingForest = predictions.length > 0 && predictions.every(p => p.forecastModel === 'random-forest');
        const bt = usingForest ? first.forecastBacktest : null;
        const hbt = usingForest ? first.horizonBacktest : null;

        // "Last month" is the newest month any area has records for; the forecast starts the
        // month after it. Older servers only send predictedNextMonth, so fall back to that.
        const lastMonth = predictions.reduce((latest, p) => {
            const m = p.history && p.history.length ? p.history[p.history.length - 1].month : '';
            return m > latest ? m : latest;
        }, '');
        const futureMonths = first && first.forecastMonths && first.forecastMonths.length
            ? first.forecastMonths
            : [first && first.forecastMonth ? first.forecastMonth : addMonths(lastMonth || '2000-01', 1)];
        const maxHorizon = futureMonths.length;
        const minDate = firstDay(futureMonths[0]);
        const maxDate = lastDay(futureMonths[maxHorizon - 1]);
        const barangays = [...new Set(predictions.map(p => p.barangay))].sort();

        const pathOf = p => (p.forecastPath && p.forecastPath.length ? p.forecastPath : [p.predictedNextMonth]);
        const countIn = (p, month) => (p.history || []).find(h => h.month === month)?.count || 0;
        const clampDate = iso => (iso < minDate ? minDate : iso > maxDate ? maxDate : iso);
        // Error per area at k months ahead, from the back-tests (null = never tested that far).
        // Where the next-month test ran: a span of months (current server) or one month (older).
        const btSpan = bt ? (bt.from && bt.from !== bt.month ? `${shortMonth(bt.from)} – ${shortMonth(bt.month)}` : shortMonth(bt.month)) : '';
        const errorAt = k => (k === 1 && bt ? bt.maeForest : hbt && hbt.mae[k - 1] != null ? hbt.mae[k - 1] : null);

        const defaultState = () => ({ from: minDate, to: lastDay(futureMonths[0]), barangay: '' });

        function restoreState(key) {
            const state = defaultState();
            try { // remembered per viewer; harmless if storage is blocked
                const saved = JSON.parse(localStorage.getItem(key) || '{}');
                if (isDate(saved.from) && isDate(saved.to) && saved.from <= saved.to && saved.from >= minDate && saved.to <= maxDate) {
                    state.from = saved.from; state.to = saved.to;
                }
                if (saved.barangay && barangays.includes(saved.barangay)) state.barangay = saved.barangay;
            } catch (e) { /* defaults */ }
            state.storageKey = key;
            return state;
        }
        function saveState(state) {
            if (!state.storageKey) return;
            try { localStorage.setItem(state.storageKey, JSON.stringify({ from: state.from, to: state.to, barangay: state.barangay })); } catch (e) { /* ignore */ }
        }

        /* The chosen window is a pair of calendar dates. The model forecasts whole months, so a
           month the window only partly covers counts for the share of its days inside the window
           (accidents assumed spread evenly through the month). */
        function view(state) {
            const fromKey = state.from.slice(0, 7), toKey = state.to.slice(0, 7);
            const S = monthIdx(fromKey) - monthIdx(futureMonths[0]);
            const E = monthIdx(toKey) - monthIdx(futureMonths[0]);
            const H = E - S + 1;          // calendar months the window touches
            const ahead = E + 1;          // how far ahead its last month is
            const months = futureMonths.slice(S, E + 1);
            const share = months.map((m, k) => {
                const startDay = k === 0 ? Number(state.from.slice(8)) : 1;
                const endDay = k === H - 1 ? Number(state.to.slice(8)) : daysIn(m);
                return (endDay - startDay + 1) / daysIn(m);
            });
            const wholeMonths = state.from === firstDay(fromKey) && state.to === lastDay(toKey);
            const monthsCovered = share.reduce((a, v) => a + v, 0);
            const days = Math.round((new Date(state.to) - new Date(state.from)) / 864e5) + 1;
            const isNext = wholeMonths && S === 0 && E === 0;
            const periodLabel = !wholeMonths
                ? (state.from === state.to ? shortDate(state.from) : `${shortDate(state.from)} – ${shortDate(state.to)}`)
                : H === 1 ? shortMonth(months[0]) : `${shortMonth(months[0])} – ${shortMonth(months[H - 1])}`;
            // Compare with the H months just recorded when the window starts next month; a window
            // further out is compared with the same months a year earlier (same season), with the
            // same day shares, so a 10-day window is compared with 10 days' worth.
            const sameSeason = !(S === 0 && wholeMonths);
            const pastMonths = sameSeason
                ? months.map(m => addMonths(m, -12))
                : Array.from({ length: H }, (_, i) => addMonths(lastMonth, i - H + 1));
            // Comparing is only fair when every comparison month has actually been recorded; for a
            // window far enough out, "last year" is itself still a forecast.
            const pastComplete = !!lastMonth && pastMonths.every(m => m <= lastMonth);
            const pastLabel = H === 1 ? shortMonth(pastMonths[0]) : `${shortMonth(pastMonths[0])} – ${shortMonth(pastMonths[H - 1])}`;
            const compareName = !pastComplete ? '' : sameSeason && !wholeMonths ? 'same dates last year' : pastLabel;
            const inScope = p => !state.barangay || p.barangay === state.barangay;

            const rows = predictions.map(p => {
                const path = pathOf(p).slice(S, E + 1).map((v, k) => v * share[k]);
                const predicted = path.reduce((a, v) => a + v, 0);
                const recorded = pastMonths.reduce((a, m, k) => a + countIn(p, m) * share[k], 0);
                // Trend over the window: its monthly rate against the last 3 real months. For
                // plain "next month" the server's own label is kept (see explain.trendChange).
                const recent = mean([0, 1, 2].map(i => countIn(p, addMonths(lastMonth, -i))));
                const avg = predicted / monthsCovered;
                const change = recent > 0 ? (avg - recent) / recent : (avg > 0 ? 1 : 0);
                const trend = isNext ? p.trend : change > 0.10 ? 'up' : change < -0.10 ? 'down' : 'stable';
                const changePct = pastComplete && recorded > 0 ? (predicted - recorded) / recorded * 100 : null;
                return { ...p, path, predicted, recorded, changePct, periodTrend: trend };
            });
            const scoped = rows.filter(inScope);
            const total = scoped.reduce((a, p) => a + p.predicted, 0);
            const pastTotal = scoped.reduce((a, p) => a + p.recorded, 0);

            const v = {
                state: { ...state }, S, E, H, ahead, months, share, wholeMonths, monthsCovered, days, isNext,
                periodLabel, pastMonths, pastLabel, sameSeason, pastComplete, compareName,
                rows, scoped, total, pastTotal, inScope
            };
            v.text = texts(v);
            return v;
        }

        /* Every heading, card and note, worded the same on both pages. */
        function texts(v) {
            const st = v.state;
            const where = st.barangay ? 'Brgy. ' + st.barangay : 'each area of Mandaluyong City';
            const t = {};
            t.subtitle = v.isNext
                ? `Predicted accidents next month for ${where}.`
                : `Advance prediction: accidents expected ${v.S === 0 && v.wholeMonths ? `over the next ${v.H} months` : `in ${v.H === 1 && v.wholeMonths ? longMonth(v.months[0]) : v.periodLabel}`} for ${where}.`;
            t.hint = (v.isNext ? '' : 'Each month ahead builds on the forecast before it, so far-off months are less certain.')
                + (v.wholeMonths ? '' : ' Part-months are prorated by day.');
            t.cityTitle = `${st.barangay || 'City'} Trend & ${v.isNext ? 'Next Month' : v.periodLabel}`;
            t.brgyTitle = !v.pastComplete ? `Predicted for ${v.periodLabel} — by Barangay`
                : v.isNext ? 'Last Month vs. Predicted — by Barangay'
                : `${!v.sameSeason ? `Last ${v.H} Months` : 'Same Period Last Year'} vs. ${v.periodLabel} — by Barangay`;
            t.tableTitle = v.isNext ? 'Predicted Accidents Next Month' : `Predicted Accidents — ${v.periodLabel}`;
            t.predHead = v.isNext ? 'Predicted next month'
                : !v.wholeMonths ? `Predicted (${plural(v.days, 'day')})`
                : v.H === 1 ? `Predicted (${shortMonth(v.months[0])})` : `Predicted (${v.H} mo.)`;
            t.compareHead = !v.pastComplete ? 'Compared with' : v.isNext ? 'Last Month'
                : !v.sameSeason ? `Last ${v.H} Months` : 'Same Period Last Year';

            t.monthValue = v.H === 1 && v.wholeMonths ? longMonth(v.months[0]) : v.periodLabel;
            t.monthLabel = v.isNext ? 'Forecast Month'
                : !v.wholeMonths ? `Forecast Period (${plural(v.days, 'day')})`
                : v.H === 1 ? `Forecast Month (${v.ahead} months ahead)` : `Forecast Period (${v.H} months)`;
            t.totalValue = num(Math.round(v.total));
            t.totalLabel = `Predicted Accidents (${st.barangay || 'City'})`
                + (!v.wholeMonths ? ` · ~${r1(v.total / v.days)}/day` : v.H > 1 ? ` · ~${num(Math.round(v.total / v.H))}/mo` : '');
            if (!v.pastComplete) {
                t.delta = { text: `no records yet for ${v.sameSeason ? 'the same period last year' : v.pastLabel} to compare with`, tone: 'muted' };
            } else if (v.pastTotal) {
                const change = Math.round((v.total - v.pastTotal) / v.pastTotal * 100);
                t.delta = { text: `${change > 0 ? '+' : ''}${change}% vs ${v.compareName} (${num(Math.round(v.pastTotal))})`, tone: change > 0 ? 'up' : change < 0 ? 'down' : 'muted' };
            } else {
                t.delta = { text: '', tone: 'muted' };
            }
            t.upValue = `${v.scoped.filter(p => p.periodTrend === 'up').length} / ${v.scoped.length}`;
            t.upLabel = st.barangay ? 'Roads Trending Up' : 'Areas Trending Up';

            if (v.isNext) {
                t.errValue = bt ? `±${bt.maeForest}` : '—';
                t.errLabel = 'Avg Error per Area';
                t.errNote = bt ? `accidents, tested on ${btSpan}`
                    + (bt.maeAverage3 != null ? ` · 3-month average: ±${bt.maeAverage3}` : '')
                    + ` · straight line: ±${bt.maeLinear}` : 'not tested yet';
            } else if (hbt && hbt.mae.length >= v.ahead) {
                t.errValue = `±${hbt.mae[v.ahead - 1]}`;
                t.errLabel = v.ahead === 1 ? 'Avg Error per Area' : `Avg Error, ${v.ahead} Months Ahead`;
                t.errNote = `accidents per area per month, tested from ${shortMonth(hbt.from)} · 1 month ahead: ±${hbt.mae[0]}`;
            } else {
                const worst = hbt && hbt.mae.length ? hbt.mae[hbt.mae.length - 1] : null;
                t.errValue = worst !== null ? `>±${worst}` : '—';
                t.errLabel = `Avg Error, ${v.ahead} Months Ahead`;
                t.errNote = worst !== null
                    ? `only tested up to ${hbt.mae.length} months ahead (±${worst}); treat as a rough outlook`
                    : 'not tested — treat as a rough outlook';
            }

            t.modelTag = !first ? ''
                : first.forecastModel === 'random-forest'
                    ? `Model: Random Forest (Python)${first.mlModel === 'random-forest' ? ' + severity model' : ''}`
                    : 'Model: linear trend (heuristic)';
            t.modelNote = first && first.forecastModel === 'random-forest'
                ? `Predictions for ${v.periodLabel} combine a Random Forest (Python, scikit-learn), which learned from every barangay's monthly history (the last three months, the 3-, 6- and 12-month averages, and the time of year), with each area's plain 3-month average; the two are averaged.`
                  + (!v.isNext ? ' Months past the first are forecast one at a time, each using the forecasts before it as its recent history, so uncertainty grows the further ahead you look.' : '')
                  + (bt ? ` Tested on ${btSpan}, months it had not seen, it was off by ${bt.maeForest} accidents per area on average`
                      + (bt.maeAverage3 != null ? ` — the 3-month average alone by ${bt.maeAverage3}, last month's count by ${bt.maeLastMonth}` : '')
                      + `, a straight-line trend by ${bt.maeLinear}.` : '')
                  + (!v.isNext && hbt ? ` Forecasting ${hbt.mae.length} unseen months from ${shortMonth(hbt.from)}, the error per area went ${hbt.mae.map(e => '±' + e).join(', ')}.` : '')
                  + (!v.isNext ? ' Risk score and level reflect the next-month assessment.' : '')
                : `Forecasts for ${v.periodLabel} use a straight-line trend per area until there is enough monthly history to train the Random Forest.`;
            return t;
        }

        /* Chart series: the scope's recorded history (last 18 months), then the forecast as a
           dashed line from the last real month to the window's end; months inside the window get
           the bigger points. */
        function cityTrend(v) {
            const byMonth = {};
            v.scoped.forEach(p => (p.history || []).forEach(h => { byMonth[h.month] = (byMonth[h.month] || 0) + h.count; }));
            const hist = Object.keys(byMonth).sort().slice(-18);
            const labels = hist.map(shortMonth);
            const actual = hist.map(m => byMonth[m]);
            const forecast = hist.map((m, i) => (i === hist.length - 1 ? actual[i] : null));
            const pointSizes = forecast.map((x, i) => (i === forecast.length - 1 ? 3 : 0));
            futureMonths.slice(0, v.E + 1).forEach((m, k) => {
                labels.push(shortMonth(m) + (v.isNext ? ' (forecast)' : ''));
                actual.push(null);
                forecast.push(Math.round(v.scoped.reduce((a, p) => a + (pathOf(p)[k] || 0), 0)));
                pointSizes.push(k >= v.S ? (v.ahead > 6 ? 4 : 5) : 2);
            });
            return { labels, actual, forecast, pointSizes, forecastLabel: v.isNext ? 'Forecast' : `Forecast (${v.periodLabel})` };
        }

        /* Bars per barangay: recorded over the comparison months vs predicted over the window.
           `recorded` is null when the comparison months have not been recorded yet. */
        function byBarangay(v) {
            const per = {};
            v.rows.forEach(p => {
                const b = per[p.barangay] || (per[p.barangay] = { recorded: 0, predicted: 0 });
                b.recorded += p.recorded; b.predicted += p.predicted;
            });
            const list = Object.entries(per).sort((a, b) => b[1].predicted - a[1].predicted);
            return {
                names: list.map(([name]) => name),
                recorded: v.pastComplete ? list.map(([, x]) => r1(x.recorded)) : null,
                predicted: list.map(([, x]) => r1(x.predicted)),
                recordedLabel: v.isNext ? `Last month (${shortMonth(lastMonth)})` : `Recorded (${v.compareName})`,
                predictedLabel: `Predicted (${v.periodLabel})`
            };
        }

        /* ---- detail-dialog figures ----
           The server's "recent average" is its last three months that have records (empty
           months are not in history); trend and risk score were computed from it. The exact
           unrounded figures come in `explain`; an older server does not send them, so they are
           rebuilt from the rounded fields (close, but can differ in the last digit). */
        const serverRecent = p => {
            const last3 = (p.history || []).slice().sort((a, b) => a.month.localeCompare(b.month)).slice(-3);
            return { months: last3, avg: mean(last3.map(h => h.count)) };
        };
        const rawRisk = p => {
            const x = p.explain;
            if (x) return { freq: x.frequencyScore, mult: x.severityMultiplier, raw: x.rawScore };
            const freq = serverRecent(p).avg * 0.55 + p.predictedNextMonth * 0.45;
            const mult = p.severeProbability == null ? 1 : 0.7 + 0.6 * p.severeProbability;
            return { freq, mult, raw: freq * mult };
        };
        const maxRaw = first && first.explain && first.explain.maxRawScore != null
            ? first.explain.maxRawScore
            : Math.max(1, ...predictions.map(p => rawRisk(p).raw));

        return {
            predictions, first, usingForest, bt, hbt, lastMonth, futureMonths, maxHorizon, minDate, maxDate, barangays,
            pathOf, countIn, clampDate, errorAt, btSpan, serverRecent, rawRisk, maxRaw,
            defaultState, restoreState, saveState, view, cityTrend, byBarangay
        };
    }

    /* ---------------- shared styles (filter bar + detail dialog) ---------------- */
    let stylesDone = false;
    function injectStyles() {
        if (stylesDone) return;
        stylesDone = true;
        const css = `
.fcx-bar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 14px}
.fcx-field{display:grid;gap:4px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.3px}
.fcx-input{height:36px;padding:6px 10px;font:500 13px inherit;font-family:inherit;color:#0f172a;border:1px solid #e2e8f0;border-radius:10px;background:#fff;text-transform:none;letter-spacing:0}
.fcx-input:focus{outline:2px solid #c7d2fe;border-color:#818cf8}
select.fcx-input{min-width:190px}
.fcx-chips{display:flex;flex-wrap:wrap;gap:6px}
.fcx-chip{padding:7px 11px;border-radius:999px;border:1px solid #e2e8f0;background:#fff;color:#334155;font:600 12px inherit;font-family:inherit;cursor:pointer}
.fcx-chip:hover{background:#f1f5f9}
.fcx-chip.active{background:#eff6ff;border-color:#cfe0ff;color:#1d4ed8}
.fcx-chip:disabled{opacity:.45;cursor:not-allowed}
.fcx-reset{padding:7px 4px;border:0;background:none;color:#dc2626;font:600 12px inherit;font-family:inherit;cursor:pointer}
.fcx-reset:hover{text-decoration:underline}
.fcx-hint{margin-left:auto;align-self:center;font-size:11.5px;color:#64748b;max-width:360px}
@media(max-width:700px){.fcx-field{flex:1 1 140px}select.fcx-input{min-width:0;width:100%}.fcx-hint{margin-left:0;max-width:none;width:100%}}
.fcx-rows tr[data-fcx]{cursor:pointer}
.fcx-rows tr[data-fcx]:hover td{background:#f5f3ff}
.fcx-rows tr[data-fcx]:focus-visible{outline:2px solid #7c3aed;outline-offset:-2px}
.fcx-modal{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.55)}
.fcx-modal[hidden]{display:none}
.fcx-card{width:min(760px,100%);max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:16px;padding:22px 24px 20px;box-shadow:0 24px 60px rgba(15,23,42,.35);color:#0f172a;text-align:left}
.fcx-head{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 12px;margin-bottom:14px}
.fcx-head h3{font-size:19px;font-weight:800;margin:0}
.fcx-sub{font-size:12.5px;color:#64748b;margin-top:2px}
.fcx-close{margin-left:auto;width:34px;height:34px;border-radius:9px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;font-size:18px;line-height:1;color:#334155;flex:none}
.fcx-close:hover{background:#f1f5f9}
.fcx-actions{margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.fcx-actions:empty{display:none}
.fcx-actions:not(:empty) + .fcx-close{margin-left:0}
.fcx-head > div:first-child{flex:1 1 220px;min-width:0}
.fcx-action{height:34px;padding:0 12px;border-radius:9px;border:1px solid #c7d2fe;background:#eef2ff;color:#3730a3;font:600 12.5px inherit;font-family:inherit;cursor:pointer;white-space:nowrap}
.fcx-action:hover{background:#e0e7ff}
.fcx-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.fcx-kpi{border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px}
.fcx-kpi b{display:block;font-size:20px;color:#0f172a}
.fcx-kpi span{font-size:11.5px;color:#64748b}
.fcx-sec{margin-top:16px}
.fcx-sec h4{font-size:13px;font-weight:800;color:#0f172a;margin:0 0 6px;text-transform:uppercase;letter-spacing:.3px}
.fcx-sec p,.fcx-sec li{font-size:13px;line-height:1.6;color:#334155;margin:0 0 6px}
.fcx-sec ul{margin:0;padding-left:18px}
.fcx-table{width:100%;border-collapse:collapse;font-size:12.5px}
.fcx-table th,.fcx-table td{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right}
.fcx-table th:first-child,.fcx-table td:first-child{text-align:left}
.fcx-table th{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.3px;background:none}
.fcx-note{font-size:11.5px;color:#64748b;margin-top:6px}
@media(max-width:600px){.fcx-card{padding:18px 16px}}`;
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    /* ---------------- filter bar ----------------
       Renders horizon chips, From/To date pickers, a barangay picker and Reset into `el`,
       mutates `state`, saves it, and calls onChange(). Returns { sync, setHint }. */
    function mountFilters(el, model, state, onChange) {
        injectStyles();
        el.innerHTML = `
            <div class="fcx-bar">
              <div class="fcx-field">Forecast horizon
                <div class="fcx-chips">${HORIZONS.map(([h, label]) => {
                    const ok = h <= model.maxHorizon;
                    const to = ok ? lastDay(model.futureMonths[h - 1]) : '';
                    return `<button type="button" class="fcx-chip" data-from="${model.minDate}" data-to="${to}"${ok ? '' : ' disabled title="Needs the updated forecast model on the server"'}>${label}</button>`;
                }).join('')}</div>
              </div>
              <label class="fcx-field">From <input type="date" class="fcx-input" data-k="from" min="${model.minDate}" max="${model.maxDate}"></label>
              <label class="fcx-field">To <input type="date" class="fcx-input" data-k="to" min="${model.minDate}" max="${model.maxDate}"></label>
              <label class="fcx-field">Barangay
                <select class="fcx-input" data-k="barangay"><option value="">All barangays (city)</option>${model.barangays.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}</select>
              </label>
              <button type="button" class="fcx-reset">Reset</button>
              <span class="fcx-hint"></span>
            </div>`;
        const q = sel => el.querySelector(sel);
        const fromEl = q('[data-k="from"]'), toEl = q('[data-k="to"]'), brgyEl = q('[data-k="barangay"]');

        function sync() {
            el.querySelectorAll('.fcx-chip').forEach(c => c.classList.toggle('active', c.dataset.from === state.from && c.dataset.to === state.to));
            fromEl.value = state.from;
            toEl.value = state.to;
            brgyEl.value = state.barangay;
            model.saveState(state);
        }
        const changed = () => { sync(); onChange(); };

        q('.fcx-chips').addEventListener('click', e => {
            const chip = e.target.closest('.fcx-chip');
            if (!chip || chip.disabled) return;
            state.from = chip.dataset.from; state.to = chip.dataset.to;
            changed();
        });
        // Dates outside the forecast are pulled back into range; picking a From after the To
        // (or a To before the From) moves the other end with it. A cleared box restores its value.
        fromEl.addEventListener('change', () => {
            if (fromEl.value) { state.from = model.clampDate(fromEl.value); if (state.to < state.from) state.to = state.from; }
            changed();
        });
        toEl.addEventListener('change', () => {
            if (toEl.value) { state.to = model.clampDate(toEl.value); if (state.from > state.to) state.from = state.to; }
            changed();
        });
        brgyEl.addEventListener('change', () => { state.barangay = brgyEl.value; changed(); });
        q('.fcx-reset').addEventListener('click', () => { Object.assign(state, model.defaultState(), { storageKey: state.storageKey }); changed(); });

        sync();
        return { sync, setHint: text => { q('.fcx-hint').textContent = text || ''; } };
    }

    /* ---------------- clickable rows ----------------
       Makes rows rendered with rowAttrs(i) open the detail dialog for v.list[i].
       opts.actions: [{ label, onClick(row, view, dialogEl) }] adds buttons to the dialog
       (the admin console uses it for "Download PDF" / "Download CSV"). */
    const rowAttrs = i => `data-fcx="${i}" tabindex="0" title="Click for details about this prediction"`;
    function bindRows(tbody, model, getView, opts) {
        injectStyles();
        tbody.fcxActions = (opts && opts.actions) || [];
        tbody.classList.add('fcx-rows');
        if (tbody.dataset.fcxBound) return;
        tbody.dataset.fcxBound = '1';
        const open = (e, tr) => {
            const v = getView();
            const p = v && v.list ? v.list[Number(tr.dataset.fcx)] : null;
            if (p) { e.preventDefault(); openDetail(model, p, v, tr, tbody.fcxActions); }
        };
        tbody.addEventListener('click', e => { const tr = e.target.closest('tr[data-fcx]'); if (tr) open(e, tr); });
        tbody.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const tr = e.target.closest('tr[data-fcx]');
            if (tr) open(e, tr);
        });
    }

    /* ---------------- detail dialog ----------------
       Every figure is the one that produced the row: the forest's inputs (ml/forecast_forest.py
       `features`), the trend rule, and the risk-score formula in PredictionService. */
    let modal = null, detailChart = null, lastFocus = null;
    function ensureModal() {
        if (modal) return modal;
        injectStyles();
        modal = document.createElement('div');
        modal.className = 'fcx-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="fcx-card" role="dialog" aria-modal="true" aria-labelledby="fcxTitle">
              <div class="fcx-head">
                <div><h3 id="fcxTitle">—</h3><div class="fcx-sub"></div></div>
                <div class="fcx-actions"></div>
                <button type="button" class="fcx-close" aria-label="Close">×</button>
              </div>
              <div class="fcx-body"></div>
            </div>`;
        document.body.appendChild(modal);
        modal.querySelector('.fcx-close').addEventListener('click', closeDetail);
        modal.addEventListener('click', e => { if (e.target === modal) closeDetail(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal && !modal.hidden) closeDetail(); });
        return modal;
    }
    function closeDetail() {
        if (!modal) return;
        modal.hidden = true;
        if (detailChart) { detailChart.destroy(); detailChart = null; }
        if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    function openDetail(model, p, v, focusBack, actions) {
        const m = ensureModal();
        lastFocus = focusBack || document.activeElement;
        const actionBox = m.querySelector('.fcx-actions');
        actionBox.innerHTML = '';
        (actions || []).forEach(a => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'fcx-action';
            btn.textContent = a.label;
            btn.addEventListener('click', () => a.onClick(p, v, m));
            actionBox.appendChild(btn);
        });
        const { lastMonth, futureMonths, bt, hbt, btSpan, countIn, pathOf, errorAt } = model;
        const isForest = p.forecastModel === 'random-forest';
        const hist = p.history || [];

        // The monthly series the forest sees: first recorded month to the last month on file,
        // empty months counted as 0.
        const series = [];
        if (hist.length) {
            for (let mm = hist.map(h => h.month).sort()[0]; mm <= lastMonth; mm = addMonths(mm, 1)) series.push({ month: mm, count: countIn(p, mm) });
        }
        const tail = n => series.slice(-n).map(s => s.count);
        const lags = series.slice(-3).reverse();
        const monthlyRate = p.predicted / v.monthsCovered;
        const change = v.pastComplete && p.recorded > 0 ? (p.predicted - p.recorded) / p.recorded : null;
        const recentCal = mean([0, 1, 2].map(i => countIn(p, addMonths(lastMonth, -i))));
        const sr = model.serverRecent(p);
        const risk = model.rawRisk(p);

        m.querySelector('#fcxTitle').textContent = p.road && p.road !== 'Unknown' && p.road !== 'All Roads' ? `${p.barangay} — ${p.road}` : p.barangay;
        m.querySelector('.fcx-sub').textContent = `Forecast for ${v.periodLabel}` + (v.wholeMonths ? '' : ` (${plural(v.days, 'day')})`)
            + ` · ${isForest ? 'Random Forest model' : 'straight-line trend'}`;

        const compareText = !v.pastComplete
            ? `There is nothing to compare it with yet: the records run to ${esc(longMonth(lastMonth))}, so ${v.sameSeason ? 'the same period last year' : esc(v.pastLabel)} has not been recorded.`
            : change === null
                ? `There were no recorded accidents in the comparison period (${esc(v.compareName)}).`
                : `That is <b>${pct(change)}</b> compared with ${v.sameSeason ? (v.wholeMonths ? `the same months last year (${esc(v.pastLabel)})` : 'the same dates last year') : `the ${v.H === 1 ? 'last recorded month' : `last ${v.H} recorded months`} (${esc(v.pastLabel)})`}, which had <b>${num(r1(p.recorded))}</b>.`;

        const monthRows = v.months.map((mm, j) => {
            const k = v.S + j + 1; // months ahead
            const full = pathOf(p)[v.S + j];
            const err = isForest ? errorAt(k) : null;
            const partial = v.share[j] < 1;
            const prev = addMonths(mm, -12);
            return `<tr><td>${esc(longMonth(mm))}${partial ? ` <span class="fcx-note">(${Math.round(v.share[j] * daysIn(mm))} of ${daysIn(mm)} days)</span>` : ''}</td>
              <td><b>${partial ? r1(full * v.share[j]) : num(full)}</b>${partial ? ` <span class="fcx-note">of ${num(full)}</span>` : ''}</td>
              <td>${prev <= lastMonth ? num(countIn(p, prev)) : '<span class="fcx-note">not recorded yet</span>'}</td>
              <td>${k} mo.</td>
              <td>${err != null ? '±' + err : isForest ? 'not tested' : '—'}</td></tr>`;
        }).join('');

        const whyForest = `
            <p>The forecast is the average of two estimates: this area's plain 3-month average, and a Random Forest trained on the monthly history of every area in the city at once. Together they were more accurate in testing than either alone. For this area the forest was given:</p>
            <ul>
              <li><b>Last 3 months:</b> ${lags.map(s => `${esc(shortMonth(s.month))}: ${num(s.count)}`).join(', ') || 'no history'}</li>
              <li><b>Averages:</b> last 3 months ${r1(mean(tail(3)))}, last 6 months ${r1(mean(tail(6)))}, last 12 months ${r1(mean(tail(12)))}, all ${series.length} months on file ${r1(mean(series.map(s => s.count)))} per month</li>
              <li><b>Time of year:</b> the calendar month being forecast, so seasonal patterns learned across all areas are applied (see “Same month last year” below).</li>
            </ul>
            ${v.S + v.H > 1 ? `<p>Months after ${esc(longMonth(futureMonths[0]))} are forecast one step at a time: each month's forecast is fed back in as if it were recorded history to forecast the next. That is why far-off months drift toward this area's long-run level and are less certain.</p>` : ''}`;
        const whyLinear = '<p>There is not yet enough monthly history to train the Random Forest, so this uses a straight line fitted through the area\'s recorded monthly counts and extended forward.</p>';

        let trendText;
        if (v.isNext && isForest) {
            const x = p.explain;
            const fc = x ? x.forecastRaw : p.predictedNextMonth;
            const ch = x ? x.trendChange : sr.avg > 0 ? (fc - sr.avg) / sr.avg : null;
            trendText = `Next month's forecast before rounding (<b>${r2(fc)}</b>) is compared with the average of this area's last 3 months that have records (${sr.months.map(h => `${esc(shortMonth(h.month))}: ${num(h.count)}`).join(', ')} → <b>${r1(sr.avg)}</b>)`
                + (ch == null ? '.' : `, a change of <b>${pct(ch)}</b>.`)
                + (sr.avg === 0 ? ' With no recent accidents, any forecast above zero counts as “up”.' : '');
        } else if (v.isNext) {
            const slope = p.explain ? p.explain.trendSlope : null;
            trendText = `The label follows the slope of the straight line${slope != null ? ` (<b>${slope > 0 ? '+' : ''}${r2(slope)}</b> accidents per month)` : ''}: more than +0.15 per month is “up”, less than −0.15 is “down”, otherwise “stable”.`;
        } else {
            const ch = recentCal > 0 ? (monthlyRate - recentCal) / recentCal : null;
            trendText = `The forecast works out to <b>${r1(monthlyRate)}</b> accidents per month over ${esc(v.periodLabel)}, compared with <b>${r1(recentCal)}</b> per month over the last 3 recorded months (${[2, 1, 0].map(i => esc(shortMonth(addMonths(lastMonth, -i)))).join(', ')})`
                + (ch === null ? '.' : `, a change of <b>${pct(ch)}</b>.`);
        }
        if (isForest || !v.isNext) trendText += ' More than 10% higher is marked “up”, more than 10% lower “down”, otherwise “stable”.';

        const sevText = p.severeProbability == null
            ? 'No severity model result for this area, so no adjustment (×1.00).'
            : `The severity model puts the chance that an accident here is serious (injury or fatal) at <b>${Math.round(p.severeProbability * 100)}%</b>, which scales the score by <b>×${r2(risk.mult)}</b> (range ×0.70 – ×1.30).`;
        const riskText = `
            <p>The risk score describes <b>next month</b> (${esc(longMonth(futureMonths[0]))}), whatever dates are selected.</p>
            <ul>
              <li><b>Volume:</b> 55% of the recent average (${r2(p.explain ? p.explain.recentAvg : sr.avg)}) + 45% of next month's forecast (${num(p.predictedNextMonth)}) = <b>${r2(risk.freq)}</b></li>
              <li><b>Severity:</b> ${sevText}</li>
              <li><b>Scaled:</b> ${r2(risk.raw)} compared with the highest area in the city (${r2(model.maxRaw)}), on a 0–10 scale = <b>${p.riskScore.toFixed(1)} / 10</b>. 7 or more is High, 4 or more is Moderate, below 4 is Low.</li>
            </ul>`;

        const lastK = v.S + v.H;
        const errLast = errorAt(lastK);
        const relText = !isForest
            ? '<p>The straight-line fallback has not been back-tested, so treat these numbers as a rough guide.</p>'
            : `<p>The model was tested on months it had not seen. ${bt ? `Forecasting ${esc(btSpan)}, it was off by <b>±${bt.maeForest}</b> accidents per area on average (${bt.maeAverage3 != null ? `3-month average alone ±${bt.maeAverage3}, ` : ''}straight line ±${bt.maeLinear}).` : ''}
               ${hbt ? ` Forecasting ${hbt.mae.length} months ahead from ${esc(shortMonth(hbt.from))}, the error per area per month was ${hbt.mae.map((e, i) => `${i + 1} mo.: ±${e}`).join(', ')}.` : ''}</p>
               <p>${errLast != null
                    ? `For this selection, expect each month's figure to be off by roughly <b>±${errLast}</b> or less on average.`
                    : `This selection reaches <b>${lastK} months ahead</b>, beyond what has been tested (${hbt ? hbt.mae.length : 1} months), so treat the later months as a rough outlook.`}
               These are averages over all areas; busier areas usually have larger swings in absolute numbers.</p>`;

        const dataNote = [
            p.road === 'Unknown' ? 'The source records do not name the road for these accidents, so they are grouped as “Unknown” within the barangay.' : '',
            `${num(p.totalIncidents)} recorded accidents from ${series.length ? esc(shortMonth(series[0].month)) : '—'} to ${esc(shortMonth(lastMonth))}.`
        ].filter(Boolean).join(' ');

        const rounded = Math.round(p.predicted);
        m.querySelector('.fcx-body').innerHTML = `
            <div class="fcx-kpis">
              <div class="fcx-kpi"><b>${num(rounded)}</b><span>Predicted, ${esc(v.periodLabel)}</span></div>
              <div class="fcx-kpi"><b>${r1(monthlyRate)}</b><span>Per month (average)</span></div>
              <div class="fcx-kpi"><b style="color:${TREND_COLOR[p.periodTrend]}">${TREND_ICON[p.periodTrend] || '■'} ${esc(p.periodTrend)}</b><span>Trend</span></div>
              <div class="fcx-kpi"><b>${p.riskScore.toFixed(1)} / 10</b><span>Risk score · ${esc(RISK_NAME[p.riskLevel] || p.riskLevel)}</span></div>
            </div>
            <div style="position:relative;height:200px"><canvas class="fcx-chart"></canvas></div>
            <div class="fcx-sec"><h4>What the forecast says</h4>
              <p>About <b>${num(rounded)}</b> accident${rounded === 1 ? '' : 's'} expected in ${esc(v.periodLabel)}${v.H > 1 || !v.wholeMonths ? ` (about ${r1(monthlyRate)} a month)` : ''}. ${compareText}</p>
              ${v.wholeMonths ? '' : '<p class="fcx-note">The model forecasts whole months; part-months are counted by the share of their days you selected, assuming accidents are spread evenly through the month.</p>'}
            </div>
            <div class="fcx-sec"><h4>Month by month</h4>
              <table class="fcx-table"><thead><tr><th>Month</th><th>Predicted</th><th>Same month last year</th><th>Ahead</th><th>Typical error</th></tr></thead>
              <tbody>${monthRows}</tbody></table>
            </div>
            <div class="fcx-sec"><h4>Why this number</h4>${isForest ? whyForest : whyLinear}</div>
            <div class="fcx-sec"><h4>Why “${esc(p.periodTrend)}”</h4><p>${trendText}</p></div>
            <div class="fcx-sec"><h4>Risk score</h4>${riskText}</div>
            <div class="fcx-sec"><h4>How reliable is it</h4>${relText}</div>
            <p class="fcx-note">${dataNote}</p>`;

        // Chart: last 12 recorded months, then the forecast up to the end of the selection.
        if (window.Chart) {
            const histMonths = series.slice(-12).map(s => s.month);
            const fut = futureMonths.slice(0, v.E + 1);
            if (detailChart) detailChart.destroy();
            detailChart = new Chart(m.querySelector('.fcx-chart'), {
                type: 'line',
                data: {
                    labels: [...histMonths, ...fut].map(shortMonth), datasets: [
                        { label: 'Recorded', data: [...histMonths.map(mm => countIn(p, mm)), ...fut.map(() => null)], borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,.12)', fill: true, tension: .3, pointRadius: 2 },
                        { label: 'Forecast (whole months)', data: [...histMonths.map((mm, i) => (i === histMonths.length - 1 ? countIn(p, mm) : null)), ...fut.map((mm, k) => pathOf(p)[k])], borderColor: '#7c3aed', borderDash: [6, 4], pointRadius: [...histMonths.map((mm, i) => (i === histMonths.length - 1 ? 3 : 0)), ...fut.map((mm, k) => (k >= v.S ? 5 : 2))], pointBackgroundColor: '#7c3aed', tension: .25 }
                    ]
                },
                options: {
                    // No animation: "Download PDF" copies this canvas, which must be fully drawn.
                    animation: false,
                    responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
                    scales: { y: { beginAtZero: true }, x: { ticks: { maxRotation: 50, font: { size: 10 } } } }
                }
            });
        } else {
            m.querySelector('.fcx-chart').parentElement.style.display = 'none';
        }

        m.hidden = false;
        m.querySelector('.fcx-close').focus();
    }

    window.ForecastCore = {
        create, mountFilters, bindRows, rowAttrs, openDetail, closeDetail, injectStyles,
        TREND_ICON, TREND_COLOR, shortMonth, longMonth, r1, num, esc
    };
})();
