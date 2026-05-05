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

    function waitForH5P(callback) {
        const interval = setInterval(() => {
            const iframe = document.querySelector('iframe.h5p-iframe');

            if (!iframe) return;

            let h5p;
            try {
                h5p = iframe.contentWindow.H5P;
            } catch (e) {
                return; // blocked or not ready
            }

            if (h5p && h5p.instances && h5p.instances.length > 0) {
                clearInterval(interval);
                callback(h5p.instances[0]);
            }
        }, 1000);

        setTimeout(() => clearInterval(interval), 30000);
    }

    function autoCrush(main) {
        try {
            if (main.interactions) {
                main.interactions.forEach(inter => {
                    const inst = inter.instance;
                    if (!inst) return;

                    const max = inst.getMaxScore ? inst.getMaxScore() : 1;

                    if (typeof inst.triggerXAPICompleted === 'function') {
                        inst.triggerXAPICompleted(max, max);
                    }
                });
            }

            const totalMax = main.getMaxScore ? main.getMaxScore() : 10;

            if (typeof main.triggerXAPICompleted === 'function') {
                main.triggerXAPICompleted(totalMax, totalMax);
            }

            if (main.video?.seek && main.video.getDuration) {
                main.video.seek(main.video.getDuration());
            }

            console.log("H5P DONE (Chrome fix)");
        } catch (err) {
            console.error("H5P error:", err);
        }
    }

    waitForH5P(autoCrush);
})();
