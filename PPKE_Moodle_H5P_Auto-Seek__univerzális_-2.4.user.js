// ==UserScript==
// @name         PPKE Moodle H5P Auto-Seek (univerzális)
// @namespace    http://tampermonkey.net/
// @version      2.4
// @description  Automatikusan olvassa ki az H5P interakciós pontokat az oldalból, és kezeli a helyes/helytelen válaszokat
// @author       $$$ CLAUDE.AI $$$ (herkr1)
// @match        https://moodle.ppke.hu/mod/hvp/view.php*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ── Interakciók kiolvasása ────────────────────────────────────────────────
    function parseInteractions() {
        try {
            const contents = window.H5PIntegration?.contents;
            if (!contents) return [];
            const results = [];
            for (const key of Object.keys(contents)) {
                const content = contents[key];
                let json;
                try { json = typeof content.jsonContent === 'string' ? JSON.parse(content.jsonContent) : content.jsonContent; }
                catch (e) { continue; }
                const interactions = json?.interactiveVideo?.assets?.interactions;
                if (!Array.isArray(interactions)) continue;
                for (const ia of interactions) {
                    const t = ia.duration?.from;
                    if (t !== undefined) {
                        results.push({
                            time: t,
                            wrongSeekTo: ia.adaptivity?.wrong?.seekTo ?? Math.max(0, t - 120),
                            label: ia.label?.replace(/<[^>]*>/g, '').trim() || '',
                        });
                    }
                }
            }
            results.sort((a, b) => a.time - b.time);
            return results;
        } catch (e) { return []; }
    }

    function getVideoDuration() {
        try {
            const contents = window.H5PIntegration?.contents;
            if (!contents) return null;
            for (const key of Object.keys(contents)) {
                const content = contents[key];
                let json;
                try { json = typeof content.jsonContent === 'string' ? JSON.parse(content.jsonContent) : content.jsonContent; }
                catch (e) { continue; }
                const es = json?.interactiveVideo?.assets?.endscreens;
                if (Array.isArray(es) && es.length > 0) return es[es.length - 1].time;
            }
        } catch (e) {}
        return null;
    }

    function fmt(s) {
        s = Math.floor(s);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    // ── iframe / doc / video hozzáférés ──────────────────────────────────────
    function getH5PFrame() { return document.querySelector('iframe.h5p-iframe'); }

    function getH5PDoc() {
        try { const f = getH5PFrame(); return f?.contentDocument || f?.contentWindow?.document || null; }
        catch (e) { return null; }
    }

    // H5P InteractiveVideo instance-t keressük az iframe window-ban
    function getH5PInstance() {
        try {
            const win = getH5PFrame()?.contentWindow;
            if (!win?.H5P?.instances) return null;
            for (const inst of win.H5P.instances) {
                // Közvetlen instance
                if (inst?.video?.seek) return inst;
                // Beágyazott
                if (inst?.instance?.video?.seek) return inst.instance;
            }
        } catch (e) {}
        return null;
    }

    // ── Seek ─────────────────────────────────────────────────────────────────
    let seekUnlocked = false;

    function doSeek(seconds) {
        // 1. H5P API
        const inst = getH5PInstance();
        if (inst) {
            try { inst.video.seek(seconds); inst.video.play(); return true; } catch (e) {}
        }
        // 2. Nyers video
        try {
            const doc = getH5PDoc();
            const v = doc?.querySelector('video');
            if (v) { v.currentTime = seconds; if (v.paused) v.play().catch(() => {}); return true; }
        } catch (e) {}
        return false;
    }

    function smartSeek(seconds, cb) {
        if (seekUnlocked) {
            doSeek(seconds);
            if (cb) setTimeout(cb, 500);
            return;
        }
        // Unlock: végére tekerünk, majd a célpontra
        const dur = getVideoDuration() || 99999;
        setStatus('Seek feloldása (végére teker: ' + fmt(dur) + ')...');
        doSeek(dur - 0.5);
        setTimeout(function () {
            doSeek(seconds);
            seekUnlocked = true;
            setStatus('Seek feloldva! Ugras: ' + fmt(seconds));
            if (cb) setTimeout(cb, 600);
        }, 1800);
    }

    // ── Válasz figyelés – POLLING alapon ─────────────────────────────────────
    // Nem event-re várunk, hanem 500ms-enként megnézzük az iframe DOM-ját
    let pollInterval = null;
    let answerHandled = false;

    function startPolling(interactions) {
        stopPolling();
        answerHandled = false;
        pollInterval = setInterval(function () {
            if (answerHandled) return;
            checkForAnswer(interactions);
        }, 500);
    }

    function stopPolling() {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }

    function checkForAnswer(interactions) {
        const doc = getH5PDoc();
        if (!doc) return;

        // Kérdés ablak látható-e egyáltalán?
        const questionContainer = doc.querySelector('.h5p-question-content');
        if (!questionContainer || questionContainer.offsetParent === null) return;

        // Visszajelzés rész látható-e? (ez jelenik meg ellenőrzés után)
        const feedback = doc.querySelector('.h5p-question-feedback');
        if (!feedback || feedback.offsetParent === null) return;

        // "Újra" gomb látható = ROSSZ válasz
        const retryBtn = doc.querySelector('.h5p-question-try-again');
        if (retryBtn && retryBtn.offsetParent !== null) {
            answerHandled = true;
            stopPolling();
            handleAnswer(interactions, false);
            return;
        }

        // Pontszám: minden pont ki van töltve = JÓ válasz
        const allPts = doc.querySelectorAll('.h5p-joubelui-score-bar-point');
        const filledPts = doc.querySelectorAll('.h5p-joubelui-score-bar-point.h5p-joubelui-has-score');
        if (allPts.length > 0 && filledPts.length === allPts.length) {
            answerHandled = true;
            stopPolling();
            handleAnswer(interactions, true);
            return;
        }

        // Alternatív: zöld/piros ikon keresése
        const correct = doc.querySelector('.h5p-correct');
        const wrong = doc.querySelector('.h5p-wrong');
        if (correct || wrong) {
            answerHandled = true;
            stopPolling();
            handleAnswer(interactions, !!correct && !wrong);
            return;
        }

        // Ha a feedback szekció látható de egyik fenti sem, nézzük a feedback szövegét
        const feedbackContent = doc.querySelector('.h5p-question-feedback-content');
        if (feedbackContent && feedbackContent.offsetParent !== null) {
            // van visszajelzés szöveg – nézzük hogy van-e "Újra" gomb bárhol
            const anyRetry = doc.querySelector('button.h5p-joubelui-button-retry, .h5p-joubelui-retry, [class*="retry"]');
            if (anyRetry && anyRetry.offsetParent !== null) {
                answerHandled = true;
                stopPolling();
                handleAnswer(interactions, false);
            }
        }
    }

    // ── Fő logika ─────────────────────────────────────────────────────────────
    let currentIndex = 0;
    let waiting = false;

    // Continue gomb megnyomása, majd várakozás amíg a popup eltűnik
    function clickContinueAndWait(cb) {
        const doc = getH5PDoc();
        if (!doc) { if (cb) cb(); return; }

        // Lehetséges Continue / Folytatás gombok az H5P adaptivity-ban
        const selectors = [
            '.h5p-interaction-button',           // fő continue gomb
            '.h5p-joubelui-button-back',          // back gomb fallback
            'button.h5p-core-button',             // generikus h5p gomb
            '[aria-label="Continue"]',
            '[aria-label="Folytatás"]',
            'button',                             // utolsó fallback: bármilyen gomb ami látható
        ];

        let continueBtn = null;
        for (const sel of selectors) {
            const btns = doc.querySelectorAll(sel);
            for (const btn of btns) {
                const txt = btn.textContent?.trim().toLowerCase() || '';
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (
                    txt.includes('continue') || txt.includes('folytat') ||
                    aria.includes('continue') || aria.includes('folytat') ||
                    btn.classList.contains('h5p-interaction-button')
                ) {
                    if (btn.offsetParent !== null) { // csak látható gomb
                        continueBtn = btn;
                        break;
                    }
                }
            }
            if (continueBtn) break;
        }

        if (continueBtn) {
            setStatus('▶ Continue gomb megnyomása...');
            continueBtn.click();
        } else {
            setStatus('(Continue gomb nem található, várakozás...)');
        }

        // Várjuk amíg a kérdés popup eltűnik (max 8s)
        let waited = 0;
        const waitDisappear = setInterval(function () {
            waited += 300;
            const doc2 = getH5PDoc();
            const popup = doc2?.querySelector('.h5p-question-content');
            const gone = !popup || popup.offsetParent === null;
            if (gone || waited > 8000) {
                clearInterval(waitDisappear);
                if (cb) setTimeout(cb, 400); // kis extra buffer
            }
        }, 300);
    }

    function handleAnswer(interactions, isCorrect) {
        waiting = false;
        const inter = interactions[currentIndex];
        if (!inter) return;

        if (isCorrect) {
            setStatus('✅ Helyes! 2mp várakozás...');
            // 1. Kemény 2mp várakozás
            setTimeout(function () {
                // 2. Continue gomb megnyomása + popup eltűnésére várunk
                clickContinueAndWait(function () {
                    // 3. Tekerés a következő kérdésre
                    currentIndex++;
                    goToInteraction(interactions, currentIndex);
                });
            }, 2000);
        } else {
            setStatus('❌ Helytelen! ↩ Visszatekerés: <b>' + fmt(inter.wrongSeekTo) + '</b>');
            setTimeout(function () {
                // Rossz válasznál is kattintunk Continue/Újra-ra ha van
                clickContinueAndWait(function () {
                    smartSeek(inter.wrongSeekTo, function () {
                        setTimeout(function () {
                            goToInteraction(interactions, currentIndex);
                        }, 1500);
                    });
                });
            }, 1500);
        }
    }

    function goToInteraction(interactions, index) {
        stopPolling();
        answerHandled = false;

        if (index >= interactions.length) {
            setStatus('🎉 Minden kérdést teljesítettél!');
            const btn = document.getElementById('autoseek-btn');
            if (btn) { btn.textContent = 'Kész!'; btn.disabled = false; }
            return;
        }

        const inter = interactions[index];
        highlightItem(index, interactions.length);
        setStatus('<b>' + (index + 1) + '/' + interactions.length + '.</b> kérdés → <b>' + fmt(inter.time) + '</b>');

        smartSeek(Math.max(0, inter.time - 1.5), function () {
            // Kérdés megjelenése után indítjuk a polling-ot
            setTimeout(function () {
                startPolling(interactions);
            }, 2000);
        });
    }

    // ── Videó / H5P betöltés figyelése ───────────────────────────────────────
    function startAutoSeek(interactions) {
        if (!interactions.length) { setStatus('Nem találtam kérdéspontokat!'); return; }

        const btn = document.getElementById('autoseek-btn');
        if (btn) { btn.textContent = 'Fut...'; btn.disabled = true; }

        currentIndex = 0;
        waiting = false;
        seekUnlocked = false;
        stopPolling();

        setStatus('H5P betöltésre vár...');

        let attempts = 0;
        const wait = setInterval(function () {
            attempts++;
            if (attempts > 120) {
                clearInterval(wait);
                setStatus('❌ Timeout – töltsd újra az oldalt.');
                if (btn) { btn.textContent = 'Auto-Seek'; btn.disabled = false; }
                return;
            }

            // Elég ha a videó elem vagy az H5P instance megvan
            const inst = getH5PInstance();
            const rawVideo = getH5PDoc()?.querySelector('video');

            if (inst || rawVideo) {
                clearInterval(wait);
                setStatus('✅ H5P kész! Indul...');
                try { if (inst) inst.video.play(); else rawVideo.play().catch(() => {}); } catch (e) {}
                setTimeout(function () {
                    setupAnswerWatcher(interactions); // xAPI backup
                    goToInteraction(interactions, currentIndex);
                }, 1500);
            } else if (attempts % 5 === 0) {
                setStatus('Várakozás... (' + attempts + 's)<br><small>Nyomj Play-t a videón ha nem indul!</small>');
            }
        }, 1000);
    }

    // xAPI backup – ha a polling valamiért lassú lenne
    function setupAnswerWatcher(interactions) {
        window.addEventListener('message', function (ev) {
            if (answerHandled) return;
            try {
                const stmt = ev.data?.statement;
                if (!stmt) return;
                const verbId = stmt.verb?.id || '';
                if (!verbId.includes('answered') && !verbId.includes('completed')) return;
                const result = stmt.result;
                const score = result?.score;
                let isMax = result?.success === true;
                if (!isMax && score?.raw !== undefined && score?.max !== undefined) isMax = score.raw >= score.max;
                answerHandled = true;
                stopPolling();
                handleAnswer(interactions, isMax);
            } catch (e) {}
        });
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    function createUI(interactions) {
        const wrapper = document.createElement('div');
        wrapper.id = 'autoseek-wrapper';
        Object.assign(wrapper.style, {
            position: 'fixed', bottom: '20px', right: '20px', zIndex: '99999',
            display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px',
            fontFamily: 'sans-serif',
        });

        const status = document.createElement('div');
        status.id = 'autoseek-status';
        Object.assign(status.style, {
            padding: '8px 12px', background: 'rgba(0,0,0,0.85)', color: '#fff',
            borderRadius: '8px', fontSize: '13px', maxWidth: '310px',
            display: 'none', lineHeight: '1.6',
        });

        const listPanel = document.createElement('div');
        listPanel.id = 'autoseek-list';
        Object.assign(listPanel.style, {
            padding: '10px 14px', background: 'rgba(20,20,40,0.95)', color: '#fff',
            borderRadius: '10px', fontSize: '12px', maxWidth: '310px',
            display: 'none', lineHeight: '1.8',
        });
        const listTitle = document.createElement('div');
        listTitle.textContent = 'Kérdéspontok (' + interactions.length + ' db):';
        Object.assign(listTitle.style, { fontWeight: 'bold', marginBottom: '6px', fontSize: '13px' });
        listPanel.appendChild(listTitle);
        interactions.forEach(function (inter, i) {
            const row = document.createElement('div');
            row.id = 'autoseek-item-' + i;
            row.textContent = (i + 1) + '. ' + fmt(inter.time) + (inter.label ? ' – ' + inter.label.substring(0, 30) : '');
            Object.assign(row.style, { padding: '2px 5px', borderRadius: '4px', transition: 'background 0.3s' });
            listPanel.appendChild(row);
        });

        const btnRow = document.createElement('div');
        Object.assign(btnRow.style, { display: 'flex', gap: '8px' });

        const startBtn = document.createElement('button');
        startBtn.id = 'autoseek-btn';
        startBtn.textContent = 'Auto-Seek';
        styleBtn(startBtn, '#e63946');

        const listBtn = document.createElement('button');
        listBtn.textContent = 'Lista';
        styleBtn(listBtn, '#457b9d');
        listBtn.addEventListener('click', function () {
            listPanel.style.display = listPanel.style.display === 'none' ? 'block' : 'none';
        });

        const resetBtn = document.createElement('button');
        resetBtn.textContent = 'Reset';
        styleBtn(resetBtn, '#555');
        resetBtn.addEventListener('click', function () {
            currentIndex = 0; waiting = false; seekUnlocked = false;
            stopPolling(); answerHandled = false;
            setStatus('↺ Visszaállítva.');
            highlightItem(-1, interactions.length);
            const btn = document.getElementById('autoseek-btn');
            if (btn) { btn.textContent = 'Auto-Seek'; btn.disabled = false; }
        });

        btnRow.appendChild(startBtn);
        btnRow.appendChild(listBtn);
        btnRow.appendChild(resetBtn);
        wrapper.appendChild(status);
        wrapper.appendChild(listPanel);
        wrapper.appendChild(btnRow);
        document.body.appendChild(wrapper);

        startBtn.addEventListener('click', function () { startAutoSeek(interactions); });
    }

    function styleBtn(btn, bg) {
        Object.assign(btn.style, {
            padding: '9px 14px', background: bg, color: '#fff', border: 'none',
            borderRadius: '8px', fontWeight: 'bold', fontSize: '13px',
            cursor: 'pointer', boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
        });
    }

    function setStatus(msg) {
        const el = document.getElementById('autoseek-status');
        if (el) { el.style.display = 'block'; el.innerHTML = msg; }
        console.log('[AutoSeek]', msg.replace(/<[^>]*>/g, ''));
    }

    function highlightItem(activeIndex, total) {
        for (let i = 0; i < total; i++) {
            const el = document.getElementById('autoseek-item-' + i);
            if (!el) continue;
            if (i === activeIndex) Object.assign(el.style, { background: '#e63946', fontWeight: 'bold', opacity: '1' });
            else if (i < activeIndex) Object.assign(el.style, { background: '#2a9d5c', fontWeight: 'normal', opacity: '0.7' });
            else Object.assign(el.style, { background: 'transparent', fontWeight: 'normal', opacity: '1' });
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function init() {
        setTimeout(function () {
            const interactions = parseInteractions();
            console.log('[AutoSeek] ' + interactions.length + ' interakció:', interactions);
            createUI(interactions);
            if (!interactions.length) {
                setStatus('⚠️ Nem találtam H5P interakciókat.');
                document.getElementById('autoseek-status').style.display = 'block';
            }
        }, 2500);
    }

    if (document.readyState === 'complete') init();
    else window.addEventListener('load', init);

})();
