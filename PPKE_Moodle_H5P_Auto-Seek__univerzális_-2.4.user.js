// ==UserScript==
// @name         PPKE H5P Cheat Sheet + AUTO
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Mutatja a kérdések időpontjait és a helyes válaszokat, AUTO móddal ami mindent megcsinál helyetted
// @author       Claude.ai
// @match        https://moodle.ppke.hu/mod/hvp/view.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let autoRunning = false;
    let autoAborted = false;

    // ── Helyes válasz kinyerése kérdéstípusonként ─────────────────────────────

    function extractAnswer(action) {
        if (!action) return null;
        const lib = (action.library || '').split(' ')[0];
        const p = action.params || {};

        switch (lib) {

            case 'H5P.MultiChoice': {
                const answers = (p.answers || [])
                    .filter(a => a.correct)
                    .map(a => stripTags(a.text || ''));
                return {
                    type: 'Feleletválasztós',
                    question: stripTags(p.question || ''),
                    answers,
                };
            }

            case 'H5P.TrueFalse': {
                return {
                    type: 'Igaz/Hamis',
                    question: stripTags(p.question || ''),
                    answers: [p.correct === 'true' ? 'Igaz ✓' : 'Hamis ✓'],
                };
            }

            case 'H5P.Blanks': {
                // "Fill in the blanks" – a helyes szavak 1:szó1:szó2 formátumban
                const answers = [];
                for (const q of (p.questions || [])) {
                    const text = q.params || q || '';
                    const matches = String(text).match(/\*([^*]+)\*/g) || [];
                    for (const m of matches) {
                        const opts = m.replace(/\*/g, '').split(':').filter(Boolean);
                        answers.push(opts[0] || opts.join('/'));
                    }
                }
                return {
                    type: 'Kiegészítős',
                    question: stripTags(p.text || ''),
                    answers,
                };
            }

            case 'H5P.SingleChoiceSet': {
                // Az első válasz mindig a helyes
                const sets = (p.choices || []).map(c => ({
                    q: stripTags(c.question || ''),
                    a: stripTags((c.answers || [])[0] || ''),
                }));
                return {
                    type: 'Egyválasztós sor',
                    question: sets.map(s => s.q).filter(Boolean).join(' / '),
                    answers: sets.map(s => s.a).filter(Boolean),
                };
            }

            case 'H5P.DragQuestion': {
                const answers = [];
                for (const el of (p.question?.settings?.elements || [])) {
                    if (el.dropZones?.length && el.type?.params?.alt) {
                        answers.push(stripTags(el.type.params.alt));
                    }
                }
                return {
                    type: 'Húzós',
                    question: stripTags(p.question?.settings?.question || ''),
                    answers,
                };
            }

            case 'H5P.DragText': {
                const answers = [];
                const text = p.textField || '';
                const matches = text.match(/\*([^*]+)\*/g) || [];
                for (const m of matches) {
                    answers.push(m.replace(/\*/g, '').split(':')[0]);
                }
                return {
                    type: 'Szövegbe húzós',
                    question: '',
                    answers,
                };
            }

            case 'H5P.Summary': {
                // Az első lista elem a helyes
                const answers = (p.summaries || []).flatMap(s =>
                    s.summary ? [stripTags(s.summary[0] || '')] : []
                );
                return {
                    type: 'Összefoglaló',
                    question: '',
                    answers,
                };
            }

            default:
                return {
                    type: lib.replace('H5P.', '') || 'Ismeretlen',
                    question: '',
                    answers: [],
                };
        }
    }

    function stripTags(s) {
        return String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
    }

    // ── Adatok összegyűjtése ──────────────────────────────────────────────────

    function collectData() {
        try {
            const contents = window.H5PIntegration?.contents;
            if (!contents) return [];

            const results = [];
            for (const key of Object.keys(contents)) {
                const content = contents[key];
                let json;
                try {
                    json = typeof content.jsonContent === 'string'
                        ? JSON.parse(content.jsonContent)
                        : content.jsonContent;
                } catch (e) { continue; }

                const interactions = json?.interactiveVideo?.assets?.interactions;
                if (!Array.isArray(interactions)) continue;

                for (const ia of interactions) {
                    const t = ia.duration?.from;
                    if (t === undefined) continue;

                    const extracted = extractAnswer(ia.action);
                    results.push({
                        time: t,
                        label: stripTags(ia.label || ''),
                        ...extracted,
                    });
                }
            }

            results.sort((a, b) => a.time - b.time);
            return results;
        } catch (e) {
            console.error('[CheatSheet]', e);
            return [];
        }
    }

    // ── Formázás ──────────────────────────────────────────────────────────────

    function fmt(s) {
        s = Math.floor(s);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    // ── H5P seek ──────────────────────────────────────────────────────────────

    function getH5PInstance() {
        try {
            const win = document.querySelector('iframe.h5p-iframe')?.contentWindow;
            if (!win?.H5P?.instances) return null;
            for (const inst of win.H5P.instances) {
                if (inst?.video?.seek) return inst;
                if (inst?.instance?.video?.seek) return inst.instance;
            }
        } catch (e) {}
        return null;
    }

    function getRawVideo() {
        try {
            const doc = document.querySelector('iframe.h5p-iframe')?.contentDocument;
            return doc?.querySelector('video') || null;
        } catch (e) { return null; }
    }

    // 1 másodperccel a megadott időpont elé teker
    function seekTo(seconds) {
        const target = Math.max(0, seconds - 1);

        const inst = getH5PInstance();
        if (inst) {
            try { inst.video.seek(target); inst.video.play(); return true; } catch (e) {}
        }

        const v = getRawVideo();
        if (v) {
            v.currentTime = target;
            v.play().catch(() => {});
            return true;
        }

        return false;
    }

    // ── AUTO MODE: Válaszok automatikus kitöltése ────────────────────────────

    function getH5PDoc() {
        try {
            return document.querySelector('iframe.h5p-iframe')?.contentDocument;
        } catch (e) { return null; }
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function clickElementByText(doc, text, selector = '*') {
        if (!text) return false;
        const cleanText = text.toLowerCase().trim();
        const elements = Array.from(doc.querySelectorAll(selector));

        for (const el of elements) {
            const elText = (el.textContent || '').toLowerCase().trim();
            if (elText === cleanText || elText.includes(cleanText) || cleanText.includes(elText)) {
                el.click();
                return true;
            }
        }
        return false;
    }

    function fillInputByValue(doc, value) {
        if (!value) return false;
        const inputs = doc.querySelectorAll('input[type="text"], input:not([type])');

        for (const input of inputs) {
            if (!input.value || input.value.trim() === '') {
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
        }
        return false;
    }

    async function answerCurrentQuestion(data) {
        const doc = getH5PDoc();
        if (!doc) return false;

        await wait(800);

        // Próbáljuk meg a válaszokat kitölteni/kattintani
        let success = false;

        for (const answer of (data.answers || [])) {
            if (autoAborted) return false;

            // Feleletválasztós, igaz/hamis stb. - gombra/labelre kattintás
            if (clickElementByText(doc, answer, 'button, label, .h5p-answer, .h5p-alternative')) {
                success = true;
                await wait(300);
            }
            // Kiegészítős - input mezők
            else if (fillInputByValue(doc, answer)) {
                success = true;
                await wait(300);
            }
        }

        await wait(500);

        // Submit/Check gomb keresése és kattintása
        const submitSelectors = [
            'button.h5p-question-check-answer',
            'button.h5p-joubelui-button',
            '.h5p-question-check-answer',
            'button[type="submit"]',
            'button:contains("Check")',
            'button:contains("Ellenőrzés")'
        ];

        for (const sel of submitSelectors) {
            const btn = doc.querySelector(sel);
            if (btn && btn.offsetParent !== null) {
                await wait(400);
                btn.click();
                success = true;
                break;
            }
        }

        return success;
    }

    async function submitFinalAnswers() {
        console.log('[AUTO] Keresem a csillag gombot...');
        const doc = getH5PDoc();
        if (!doc) return false;

        await wait(1000);

        // A konkrét csillag gomb amit te találtál
        const starButton = doc.querySelector('.h5p-control.h5p-star[aria-label*="summary"]');

        if (starButton) {
            console.log('[AUTO] Csillag gomb megtalálva!');
            await wait(500);
            starButton.click();
            await wait(1500);

            // Most keressük a Submit Answers gombot a felugró dialógusban
            const submitBtn = doc.querySelector('button.h5p-joubelui-button, .h5p-summary-submit-button, button[type="submit"]');
            if (submitBtn) {
                const btnText = (submitBtn.textContent || '').toLowerCase();
                if (btnText.includes('submit') || btnText.includes('beküld')) {
                    console.log('[AUTO] Submit Answers gomb megtalálva a dialógusban!');
                    await wait(500);
                    submitBtn.click();
                    await wait(1000);

                    // Ha van megerősítő dialógus
                    const confirmBtn = doc.querySelector('.h5p-confirmation-dialog-confirm-button, button[class*="confirm"]');
                    if (confirmBtn) {
                        console.log('[AUTO] Megerősítő gomb megnyomva');
                        await wait(500);
                        confirmBtn.click();
                    }

                    return true;
                }
            }

            // Ha nem találtuk a submit gombot, próbáljuk meg az összes gombot végignézni
            const allButtons = doc.querySelectorAll('button');
            for (const btn of allButtons) {
                const text = (btn.textContent || '').toLowerCase();
                if (text.includes('submit') || text.includes('beküld') || text.includes('leadás')) {
                    console.log('[AUTO] Submit gomb talált szöveg alapján:', text);
                    await wait(500);
                    btn.click();
                    await wait(1000);
                    return true;
                }
            }
        } else {
            console.log('[AUTO] Nem találtam a csillag gombot, próbálom a videó végét...');

            // Ha nincs csillag, menjünk a videó végére
            const v = getRawVideo();
            if (v) {
                v.currentTime = v.duration - 1;
                await wait(2000);

                // Próbáljuk újra a csillag gombot
                const starBtn2 = doc.querySelector('.h5p-control.h5p-star');
                if (starBtn2) {
                    starBtn2.click();
                    await wait(1500);

                    const submitBtn = doc.querySelector('button.h5p-joubelui-button, button[type="submit"]');
                    if (submitBtn) {
                        submitBtn.click();
                        return true;
                    }
                }
            }
        }

        console.log('[AUTO] Nem sikerült leadni - lehet már be van küldve?');
        return false;
    }

    async function runAutoMode(questionsData) {
        if (autoRunning) {
            console.log('[AUTO] Már fut!');
            return;
        }

        autoRunning = true;
        autoAborted = false;

        const autoBtn = document.getElementById('cs-auto-btn');
        if (autoBtn) {
            autoBtn.textContent = 'STOP AUTO';
            autoBtn.style.background = '#ff3f3f';
        }

        console.log('[AUTO] Indítás... ' + questionsData.length + ' kérdés');

        for (let i = 0; i < questionsData.length; i++) {
            if (autoAborted) {
                console.log('[AUTO] Megszakítva!');
                break;
            }

            const item = questionsData[i];
            console.log(`[AUTO] ${i+1}/${questionsData.length} - ${fmt(item.time)} - ${item.type}`);

            // Ugrás a kérdéshez
            seekTo(item.time);
            await wait(2000); // Várunk, hogy betöltődjön a kérdés

            // Válaszolunk
            await answerCurrentQuestion(item);

            // Extra várakozás a következő kérdés előtt
            await wait(1500);
        }

        // Ha nem lett megszakítva, kommitoljuk a válaszokat
        if (!autoAborted) {
            console.log('[AUTO] Összes kérdés megválaszolva, kommitolás...');
            await wait(2000);
            await submitFinalAnswers();
        }

        autoRunning = false;
        if (autoBtn) {
            autoBtn.textContent = 'AUTO RUN';
            autoBtn.style.background = '#2a9d5c';
        }

        console.log('[AUTO] Kész!');
    }

    function stopAutoMode() {
        autoAborted = true;
        autoRunning = false;

        const autoBtn = document.getElementById('cs-auto-btn');
        if (autoBtn) {
            autoBtn.textContent = 'AUTO RUN';
            autoBtn.style.background = '#2a9d5c';
        }
    }

    // ── UI építés ─────────────────────────────────────────────────────────────

    function buildUI(data) {
        // Stílusok injektálása
        const style = document.createElement('style');
        style.textContent = `
            #cs-panel {
                position: fixed;
                top: 0; right: 0;
                width: 340px; height: 100vh;
                background: #0f0f13;
                color: #e8e6e0;
                font-family: 'Courier New', monospace;
                font-size: 12px;
                overflow-y: auto;
                z-index: 999999;
                box-shadow: -4px 0 24px rgba(0,0,0,0.6);
                transform: translateX(100%);
                transition: transform 0.3s cubic-bezier(.4,0,.2,1);
                border-left: 2px solid #ff3f3f;
            }
            #cs-panel.open { transform: translateX(0); }

            #cs-toggle {
                position: fixed;
                top: 50%;
                right: 0;
                transform: translateY(-50%);
                z-index: 1000000;
                background: #ff3f3f;
                color: #fff;
                border: none;
                cursor: pointer;
                padding: 14px 6px;
                font-size: 11px;
                font-family: 'Courier New', monospace;
                font-weight: bold;
                letter-spacing: 2px;
                writing-mode: vertical-rl;
                text-orientation: mixed;
                border-radius: 6px 0 0 6px;
                box-shadow: -2px 0 12px rgba(255,63,63,0.4);
                transition: right 0.3s cubic-bezier(.4,0,.2,1), background 0.2s;
            }
            #cs-toggle:hover { background: #ff6060; }
            #cs-toggle.shifted { right: 340px; }

            #cs-header {
                padding: 16px;
                border-bottom: 1px solid #2a2a33;
                background: #13131a;
            }
            #cs-header h1 {
                margin: 0 0 4px 0;
                font-size: 13px;
                font-weight: bold;
                color: #ff3f3f;
                letter-spacing: 3px;
                text-transform: uppercase;
            }
            #cs-header p {
                margin: 0 0 12px 0;
                color: #666;
                font-size: 11px;
            }

            #cs-auto-btn {
                width: 100%;
                background: #2a9d5c;
                color: #fff;
                border: none;
                padding: 12px;
                font-size: 13px;
                font-weight: bold;
                letter-spacing: 2px;
                cursor: pointer;
                border-radius: 4px;
                font-family: 'Courier New', monospace;
                transition: all 0.2s;
                box-shadow: 0 4px 12px rgba(42, 157, 92, 0.3);
            }
            #cs-auto-btn:hover {
                background: #35c275;
                transform: translateY(-2px);
                box-shadow: 0 6px 16px rgba(42, 157, 92, 0.4);
            }
            #cs-auto-btn:active {
                transform: translateY(0);
            }

            .cs-item {
                border-bottom: 1px solid #1e1e28;
                padding: 12px 16px;
                transition: background 0.15s;
            }
            .cs-item:hover { background: #1a1a22; }

            .cs-time {
                display: inline-block;
                background: #ff3f3f;
                color: #fff;
                font-size: 10px;
                font-weight: bold;
                padding: 2px 7px;
                border-radius: 3px;
                letter-spacing: 1px;
                margin-bottom: 6px;
                cursor: pointer;
                transition: background 0.15s, transform 0.1s;
                user-select: none;
            }
            .cs-time:hover {
                background: #ff6a6a;
                transform: scale(1.08);
            }
            .cs-time:active {
                transform: scale(0.96);
            }
            .cs-time::after {
                content: ' ▶';
                font-size: 9px;
                opacity: 0.7;
            }
            .cs-jumped {
                background: #2a9d5c !important;
            }
            .cs-type {
                display: inline-block;
                margin-left: 6px;
                color: #444;
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 1px;
            }
            .cs-question {
                color: #aaa;
                font-size: 11px;
                margin: 4px 0 6px 0;
                line-height: 1.5;
                font-style: italic;
            }
            .cs-answers {
                list-style: none;
                margin: 0; padding: 0;
            }
            .cs-answers li {
                padding: 4px 0 4px 14px;
                position: relative;
                color: #7eff9a;
                font-size: 12px;
                line-height: 1.4;
            }
            .cs-answers li::before {
                content: '▸';
                position: absolute;
                left: 0;
                color: #ff3f3f;
            }
            .cs-no-answer {
                color: #444;
                font-size: 11px;
                font-style: italic;
            }
            #cs-panel::-webkit-scrollbar { width: 4px; }
            #cs-panel::-webkit-scrollbar-track { background: #0f0f13; }
            #cs-panel::-webkit-scrollbar-thumb { background: #ff3f3f; border-radius: 2px; }
        `;
        document.head.appendChild(style);

        // Panel
        const panel = document.createElement('div');
        panel.id = 'cs-panel';

        // Header
        const header = document.createElement('div');
        header.id = 'cs-header';
        header.innerHTML = `
            <h1>Cheat Sheet</h1>
            <p>${data.length} kérdéspont találva</p>
        `;

        // AUTO gomb
        const autoBtn = document.createElement('button');
        autoBtn.id = 'cs-auto-btn';
        autoBtn.textContent = 'AUTO RUN';
        autoBtn.addEventListener('click', function() {
            if (autoRunning) {
                stopAutoMode();
            } else {
                runAutoMode(data);
            }
        });
        header.appendChild(autoBtn);

        panel.appendChild(header);

        // Kérdés lista
        data.forEach(function (item, i) {
            const div = document.createElement('div');
            div.className = 'cs-item';

            const timeEl = document.createElement('span');
            timeEl.className = 'cs-time';
            timeEl.textContent = fmt(item.time);
            timeEl.title = 'Ugrás: ' + fmt(Math.max(0, item.time - 1));
            timeEl.addEventListener('click', function () {
                const ok = seekTo(item.time);
                if (ok) {
                    timeEl.classList.add('cs-jumped');
                    setTimeout(function () { timeEl.classList.remove('cs-jumped'); }, 2000);
                } else {
                    timeEl.textContent = '✗ ' + fmt(item.time);
                    setTimeout(function () { timeEl.textContent = fmt(item.time); }, 2000);
                }
            });

            const typeEl = document.createElement('span');
            typeEl.className = 'cs-type';
            typeEl.textContent = item.type || '';

            const topRow = document.createElement('div');
            topRow.appendChild(timeEl);
            topRow.appendChild(typeEl);
            div.appendChild(topRow);

            if (item.question) {
                const q = document.createElement('div');
                q.className = 'cs-question';
                q.textContent = item.question.length > 120
                    ? item.question.substring(0, 120) + '…'
                    : item.question;
                div.appendChild(q);
            }

            const answers = item.answers || [];
            if (answers.length > 0) {
                const ul = document.createElement('ul');
                ul.className = 'cs-answers';
                answers.forEach(function (ans) {
                    if (!ans) return;
                    const li = document.createElement('li');
                    li.textContent = ans;
                    ul.appendChild(li);
                });
                div.appendChild(ul);
            } else {
                const noAns = document.createElement('div');
                noAns.className = 'cs-no-answer';
                noAns.textContent = '(nem sikerült kiolvasni a választ)';
                div.appendChild(noAns);
            }

            panel.appendChild(div);
        });

        document.body.appendChild(panel);

        // Toggle gomb
        const toggle = document.createElement('button');
        toggle.id = 'cs-toggle';
        toggle.textContent = 'CHEAT';
        document.body.appendChild(toggle);

        toggle.addEventListener('click', function () {
            const open = panel.classList.toggle('open');
            toggle.classList.toggle('shifted', open);
        });
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        setTimeout(function () {
            const data = collectData();
            console.log('[CheatSheet]', data.length + ' kérdés:', data);

            if (!data.length) {
                console.warn('[CheatSheet] Nem találtam H5P adatokat.');
                return;
            }

            buildUI(data);
        }, 2500);
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();
