/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./workbox-20b4bb42'], (function (workbox) { 'use strict';

  self.skipWaiting();
  workbox.clientsClaim();
  /**
   * The precacheAndRoute() method efficiently caches and responds to
   * requests for URLs in the manifest.
   * See https://goo.gl/S9QRab
   */
  workbox.precacheAndRoute([{
    "url": "registerSW.js",
    "revision": "402b66900e731ca748771b6fc5e7a068"
  }, {
    "url": "placeholder.svg",
    "revision": "35707bd9960ba5281c72af927b79291f"
  }, {
    "url": "icon.svg",
    "revision": "14de981ae6a0d1985d0a9bce356d9197"
  }, {
    "url": "icon.png",
    "revision": "1667e7ade35f92d5817238fee82b2997"
  }, {
    "url": "icon-512.png",
    "revision": "1667e7ade35f92d5817238fee82b2997"
  }, {
    "url": "icon-192.png",
    "revision": "4a702c28c156cd1f88c8c683e126d5c7"
  }, {
    "url": "favicon.ico",
    "revision": "ea6489aea4038bccc95c720d34d3256f"
  }, {
    "url": "_worker.js",
    "revision": "82a50da53689dbdfa0653283f5484cca"
  }, {
    "url": "assets/zap-CJZZSkPP.js",
    "revision": null
  }, {
    "url": "assets/xlsxUtils-BIWFFVap.js",
    "revision": null
  }, {
    "url": "assets/x-DkgFCX5O.js",
    "revision": null
  }, {
    "url": "assets/wind-BBdfJPog.js",
    "revision": null
  }, {
    "url": "assets/wifi-DJxTLk2E.js",
    "revision": null
  }, {
    "url": "assets/webhook-DMhbhR-l.js",
    "revision": null
  }, {
    "url": "assets/waves-Blib_Uzl.js",
    "revision": null
  }, {
    "url": "assets/volume-2-C95mYxxf.js",
    "revision": null
  }, {
    "url": "assets/video-BfP6dDO3.js",
    "revision": null
  }, {
    "url": "assets/vendor-react-sBcNjU62.js",
    "revision": null
  }, {
    "url": "assets/vendor-query-DL78LcAo.js",
    "revision": null
  }, {
    "url": "assets/vendor-dates-CIbz9neO.js",
    "revision": null
  }, {
    "url": "assets/vendor-charts-BQ_N3654.js",
    "revision": null
  }, {
    "url": "assets/utils-Bl8jtk1D.js",
    "revision": null
  }, {
    "url": "assets/users-B-xtr_su.js",
    "revision": null
  }, {
    "url": "assets/user-plus-C3SLHLVV.js",
    "revision": null
  }, {
    "url": "assets/user-Cffu2u6B.js",
    "revision": null
  }, {
    "url": "assets/useVoiceInput-BQ051sS_.js",
    "revision": null
  }, {
    "url": "assets/useVerkada-i6qOot4N.js",
    "revision": null
  }, {
    "url": "assets/useUserRole-Fp34pZEg.js",
    "revision": null
  }, {
    "url": "assets/useRealtimeSocket-CA3RJmF9.js",
    "revision": null
  }, {
    "url": "assets/useProjects-Ibbk7Idc.js",
    "revision": null
  }, {
    "url": "assets/usePWAInstall-BcELdFEq.js",
    "revision": null
  }, {
    "url": "assets/useNotionActivity-L-KGDfn-.js",
    "revision": null
  }, {
    "url": "assets/useHouseholdMembers-DpN80Y48.js",
    "revision": null
  }, {
    "url": "assets/useHomeAssistant-e8ucKnVh.js",
    "revision": null
  }, {
    "url": "assets/useAvClosetReading-CrXf08gk.js",
    "revision": null
  }, {
    "url": "assets/useAuth-ByBxSnn2.js",
    "revision": null
  }, {
    "url": "assets/use-mobile-1jch6yUL.js",
    "revision": null
  }, {
    "url": "assets/upload-Bj5adD3I.js",
    "revision": null
  }, {
    "url": "assets/tv-BYnHuQ5l.js",
    "revision": null
  }, {
    "url": "assets/trending-up-BwF0Kw5Z.js",
    "revision": null
  }, {
    "url": "assets/trash-2-CsdXZEYA.js",
    "revision": null
  }, {
    "url": "assets/toggle-right-Dr4cHs_6.js",
    "revision": null
  }, {
    "url": "assets/toggle-left-DceySlAb.js",
    "revision": null
  }, {
    "url": "assets/thermometer-ldDnb13p.js",
    "revision": null
  }, {
    "url": "assets/textarea-KeatTKlL.js",
    "revision": null
  }, {
    "url": "assets/tag-DfDIo714.js",
    "revision": null
  }, {
    "url": "assets/tabs-CNBFmKuJ.js",
    "revision": null
  }, {
    "url": "assets/switch-D7WktmK6.js",
    "revision": null
  }, {
    "url": "assets/sun-CcYlRRSV.js",
    "revision": null
  }, {
    "url": "assets/square-plus-CTLi_L-K.js",
    "revision": null
  }, {
    "url": "assets/sparkles-CklIkdpQ.js",
    "revision": null
  }, {
    "url": "assets/slider-C_Vvdn7t.js",
    "revision": null
  }, {
    "url": "assets/shopping-cart-hOUcLqNb.js",
    "revision": null
  }, {
    "url": "assets/shield-alert-CGXn8VQy.js",
    "revision": null
  }, {
    "url": "assets/shield-DdMfY46x.js",
    "revision": null
  }, {
    "url": "assets/sheet-BuJZURTF.js",
    "revision": null
  }, {
    "url": "assets/shared-DMYkWzsE.js",
    "revision": null
  }, {
    "url": "assets/settings-CV4B_F35.js",
    "revision": null
  }, {
    "url": "assets/settings-2-BnSOl4Dd.js",
    "revision": null
  }, {
    "url": "assets/send-CsrzNwaV.js",
    "revision": null
  }, {
    "url": "assets/select-_9rPtWQ4.js",
    "revision": null
  }, {
    "url": "assets/search-B7j6i6_x.js",
    "revision": null
  }, {
    "url": "assets/scroll-area-D5fI7HNp.js",
    "revision": null
  }, {
    "url": "assets/rolldown-runtime-CMxvf4Kt.js",
    "revision": null
  }, {
    "url": "assets/repeat-bWSYqNAc.js",
    "revision": null
  }, {
    "url": "assets/radio-No2EfxCD.js",
    "revision": null
  }, {
    "url": "assets/plus-bg642BCu.js",
    "revision": null
  }, {
    "url": "assets/play-Dx-eYLe9.js",
    "revision": null
  }, {
    "url": "assets/plane-DnWduk7B.js",
    "revision": null
  }, {
    "url": "assets/phone-BR9C3WfA.js",
    "revision": null
  }, {
    "url": "assets/pencil-BFvRXCXA.js",
    "revision": null
  }, {
    "url": "assets/paperclip-DAjFPRkH.js",
    "revision": null
  }, {
    "url": "assets/package-open-PQjV6vtr.js",
    "revision": null
  }, {
    "url": "assets/mic-off-rDsuHA4_.js",
    "revision": null
  }, {
    "url": "assets/mic-DO6OPldi.js",
    "revision": null
  }, {
    "url": "assets/message-square-_Fd6SiQ7.js",
    "revision": null
  }, {
    "url": "assets/map-pin-BIeZT_vd.js",
    "revision": null
  }, {
    "url": "assets/mail-CSWN6PdD.js",
    "revision": null
  }, {
    "url": "assets/list-checks-tC9M6ulv.js",
    "revision": null
  }, {
    "url": "assets/lightbulb-EsbUe3qa.js",
    "revision": null
  }, {
    "url": "assets/lib-C9ue0SWa.js",
    "revision": null
  }, {
    "url": "assets/lib-C5mA5Ran.js",
    "revision": null
  }, {
    "url": "assets/layout-dashboard-D6XHN6Cj.js",
    "revision": null
  }, {
    "url": "assets/label-DRaJJWhl.js",
    "revision": null
  }, {
    "url": "assets/janus-icon-bPX02aus.js",
    "revision": null
  }, {
    "url": "assets/janus-icon-BbtWfLjn.png",
    "revision": null
  }, {
    "url": "assets/input-Z97pQC3P.js",
    "revision": null
  }, {
    "url": "assets/index-DoGmCwng.css",
    "revision": null
  }, {
    "url": "assets/index-CX2-5aRu.js",
    "revision": null
  }, {
    "url": "assets/folder-open-D25nz9ZA.js",
    "revision": null
  }, {
    "url": "assets/flower-2-DoDZBrwr.js",
    "revision": null
  }, {
    "url": "assets/filter-C51aUsJ6.js",
    "revision": null
  }, {
    "url": "assets/file-text-D3vy6oJi.js",
    "revision": null
  }, {
    "url": "assets/eye-DjPp-Kfj.js",
    "revision": null
  }, {
    "url": "assets/external-link-BbLhdudx.js",
    "revision": null
  }, {
    "url": "assets/es2015-CxZ31IiT.js",
    "revision": null
  }, {
    "url": "assets/droplets-GPOdASuS.js",
    "revision": null
  }, {
    "url": "assets/download-GmxRAD8z.js",
    "revision": null
  }, {
    "url": "assets/door-open-ED1B3o5-.js",
    "revision": null
  }, {
    "url": "assets/dollar-sign-BCiYLDhu.js",
    "revision": null
  }, {
    "url": "assets/dist-pBalOyCw2.js",
    "revision": null
  }, {
    "url": "assets/dist-Ds2wKeYF2.js",
    "revision": null
  }, {
    "url": "assets/dist-D10lTgPm.js",
    "revision": null
  }, {
    "url": "assets/dist-CGMXWT2j.js",
    "revision": null
  }, {
    "url": "assets/dist-C3ETDryV.js",
    "revision": null
  }, {
    "url": "assets/dist-C2J943E6.js",
    "revision": null
  }, {
    "url": "assets/createLucideIcon-ZNmHFeta.js",
    "revision": null
  }, {
    "url": "assets/collapsible-yvmv7ptN.js",
    "revision": null
  }, {
    "url": "assets/code-B5OeWOuJ.js",
    "revision": null
  }, {
    "url": "assets/cloud-CgdLWxJ_.js",
    "revision": null
  }, {
    "url": "assets/clock-3-zpal6UhZ.js",
    "revision": null
  }, {
    "url": "assets/claude-icon-Bb7_g8BE.png",
    "revision": null
  }, {
    "url": "assets/circle-check-big-CpAam4FH.js",
    "revision": null
  }, {
    "url": "assets/circle-alert-BcVJ4J-g.js",
    "revision": null
  }, {
    "url": "assets/chevron-right-BFxSiCT0.js",
    "revision": null
  }, {
    "url": "assets/chevron-left-BctyJCpe.js",
    "revision": null
  }, {
    "url": "assets/chevron-down-D5nlUEql.js",
    "revision": null
  }, {
    "url": "assets/check-Kr7lBHza.js",
    "revision": null
  }, {
    "url": "assets/chart-column-2vTIqIV0.js",
    "revision": null
  }, {
    "url": "assets/card-Dkjhdi-p.js",
    "revision": null
  }, {
    "url": "assets/car-Co1mMYh-.js",
    "revision": null
  }, {
    "url": "assets/camera-DQLjC3h9.js",
    "revision": null
  }, {
    "url": "assets/calendar-days-BINxtXOa.js",
    "revision": null
  }, {
    "url": "assets/calendar-clock-BvP6W3Al.js",
    "revision": null
  }, {
    "url": "assets/calendar-DLvOSVbR.js",
    "revision": null
  }, {
    "url": "assets/button-DIgU4yVJ.js",
    "revision": null
  }, {
    "url": "assets/brain-CsXLyiy6.js",
    "revision": null
  }, {
    "url": "assets/book-open-CsGZZBQt.js",
    "revision": null
  }, {
    "url": "assets/battery-low-IbvsK0h5.js",
    "revision": null
  }, {
    "url": "assets/badge-ZOc4Dmwx.js",
    "revision": null
  }, {
    "url": "assets/avatar-DLzXRnq5.js",
    "revision": null
  }, {
    "url": "assets/arrow-right-CIQqIkKo.js",
    "revision": null
  }, {
    "url": "assets/arrow-left-DHD6ZMVe.js",
    "revision": null
  }, {
    "url": "assets/apiClient-CJ7hyapx.js",
    "revision": null
  }, {
    "url": "assets/alert-dialog-Dtn3cNnl.js",
    "revision": null
  }, {
    "url": "assets/activity-BEaGezgI.js",
    "revision": null
  }, {
    "url": "assets/accordion-Dy3DzIYi.js",
    "revision": null
  }, {
    "url": "assets/Weather-UMF67jWD.js",
    "revision": null
  }, {
    "url": "assets/Updates-C3X8AzeP.js",
    "revision": null
  }, {
    "url": "assets/TimeAdmin-C88LzE6O.js",
    "revision": null
  }, {
    "url": "assets/Time-DLSDGL7K.js",
    "revision": null
  }, {
    "url": "assets/TeslaCallback-BlkRM6HX.js",
    "revision": null
  }, {
    "url": "assets/SystemCard-RL_T5_U8.js",
    "revision": null
  }, {
    "url": "assets/Settings-COLsn6Mj.js",
    "revision": null
  }, {
    "url": "assets/SecurityCameras-DSHfEo5j.js",
    "revision": null
  }, {
    "url": "assets/Search-BLNbKfQu.js",
    "revision": null
  }, {
    "url": "assets/SaunaLogicCard-DjMI_2d8.js",
    "revision": null
  }, {
    "url": "assets/ResetPassword-CQtbr9R3.js",
    "revision": null
  }, {
    "url": "assets/Projects-MBEI7jhH.js",
    "revision": null
  }, {
    "url": "assets/ProjectWorkspace-C-CnIW3F.js",
    "revision": null
  }, {
    "url": "assets/ProductivityDay-CqUE7brd.js",
    "revision": null
  }, {
    "url": "assets/PoolTempChart-CexINFyE.js",
    "revision": null
  }, {
    "url": "assets/NotionActivityChart-Bivjo6kr.js",
    "revision": null
  }, {
    "url": "assets/NotFound-T6ZA4tw4.js",
    "revision": null
  }, {
    "url": "assets/MobileBottomNav-DM9TisGM.js",
    "revision": null
  }, {
    "url": "assets/JanusFullscreen-Do_s_e0R.js",
    "revision": null
  }, {
    "url": "assets/JanusDrawer-CjXVg1kT.js",
    "revision": null
  }, {
    "url": "assets/Install-BqeaM52z.js",
    "revision": null
  }, {
    "url": "assets/Index-jSsCubFP.js",
    "revision": null
  }, {
    "url": "assets/Iaqualink-C-Iynusc.js",
    "revision": null
  }, {
    "url": "assets/HomeSystems-CKrQACbT.js",
    "revision": null
  }, {
    "url": "assets/HomePage-8vsCl-Zz.js",
    "revision": null
  }, {
    "url": "assets/GoogleCallback-BY_1BxP_.js",
    "revision": null
  }, {
    "url": "assets/Family-D5-dDtBH.js",
    "revision": null
  }, {
    "url": "assets/DashboardProductivity-DMoaYwTr.js",
    "revision": null
  }, {
    "url": "assets/DashboardNav-QW1Am52R.js",
    "revision": null
  }, {
    "url": "assets/DashboardHeader-BSl4AqGd.js",
    "revision": null
  }, {
    "url": "assets/DashboardGreeting-De-VchoT.js",
    "revision": null
  }, {
    "url": "assets/Dashboard-BHvykq67.js",
    "revision": null
  }, {
    "url": "assets/Automations-Csq6KeLC.js",
    "revision": null
  }, {
    "url": "assets/AmazonOrder-So-TpWLH.js",
    "revision": null
  }, {
    "url": "assets/Admin-6iAKHIz6.js",
    "revision": null
  }, {
    "url": "assets/Activity-B1cuecpQ.js",
    "revision": null
  }, {
    "url": "icon.svg",
    "revision": "14de981ae6a0d1985d0a9bce356d9197"
  }, {
    "url": "manifest.webmanifest",
    "revision": "2d435751b484c3716cbf0511627bfb6a"
  }], {});
  workbox.cleanupOutdatedCaches();
  workbox.registerRoute(({
    request
  }) => request.mode === "navigate", new workbox.NetworkOnly(), 'GET');
  workbox.registerRoute(/^https:\/\/fonts\.googleapis\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "google-fonts-cache",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');
  workbox.registerRoute(/^https:\/\/fonts\.gstatic\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "gstatic-fonts-cache",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');

}));
