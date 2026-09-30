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
    "url": "assets/utensils-crossed-CB8d2W3-.js",
    "revision": null
  }, {
    "url": "assets/users-B-xtr_su.js",
    "revision": null
  }, {
    "url": "assets/user-plus-Ck5MVBsV.js",
    "revision": null
  }, {
    "url": "assets/user-Cffu2u6B.js",
    "revision": null
  }, {
    "url": "assets/useVoiceInput-BQ051sS_.js",
    "revision": null
  }, {
    "url": "assets/useVerkada-Vg-0Joap.js",
    "revision": null
  }, {
    "url": "assets/useUserRole-7VrEMexS.js",
    "revision": null
  }, {
    "url": "assets/useRealtimeSocket-BLZQ1w37.js",
    "revision": null
  }, {
    "url": "assets/useProjects-BjB456gr.js",
    "revision": null
  }, {
    "url": "assets/usePWAInstall-BcELdFEq.js",
    "revision": null
  }, {
    "url": "assets/useNotionActivity--D5ww19G.js",
    "revision": null
  }, {
    "url": "assets/useHomeAssistant-BRpVu7nP.js",
    "revision": null
  }, {
    "url": "assets/useAvClosetReading-Dul0mERW.js",
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
    "url": "assets/tabs-Ki_JWiz-.js",
    "revision": null
  }, {
    "url": "assets/switch-CblcWqHF.js",
    "revision": null
  }, {
    "url": "assets/sun-CcYlRRSV.js",
    "revision": null
  }, {
    "url": "assets/star-B0FZg8tI.js",
    "revision": null
  }, {
    "url": "assets/square-plus-CTLi_L-K.js",
    "revision": null
  }, {
    "url": "assets/sparkles-CklIkdpQ.js",
    "revision": null
  }, {
    "url": "assets/slider-C8-2uNzT.js",
    "revision": null
  }, {
    "url": "assets/skip-forward-D0NVOMaQ.js",
    "revision": null
  }, {
    "url": "assets/shopping-cart-hOUcLqNb.js",
    "revision": null
  }, {
    "url": "assets/shield-alert-B09Gxjqb.js",
    "revision": null
  }, {
    "url": "assets/shield-DdMfY46x.js",
    "revision": null
  }, {
    "url": "assets/sheet-IqsvWzCz.js",
    "revision": null
  }, {
    "url": "assets/shared-CwmWgXhj.js",
    "revision": null
  }, {
    "url": "assets/settings-Cr3E3IDk.js",
    "revision": null
  }, {
    "url": "assets/settings-2-BnSOl4Dd.js",
    "revision": null
  }, {
    "url": "assets/send-CsrzNwaV.js",
    "revision": null
  }, {
    "url": "assets/select-PTxLYtP4.js",
    "revision": null
  }, {
    "url": "assets/search-B7j6i6_x.js",
    "revision": null
  }, {
    "url": "assets/scroll-area-C2Fjb6_G.js",
    "revision": null
  }, {
    "url": "assets/rotate-ccw-B3ixE5ZI.js",
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
    "url": "assets/pencil-BFvRXCXA.js",
    "revision": null
  }, {
    "url": "assets/paperclip-DAjFPRkH.js",
    "revision": null
  }, {
    "url": "assets/package-open-PQjV6vtr.js",
    "revision": null
  }, {
    "url": "assets/package-h-84k6Nb.js",
    "revision": null
  }, {
    "url": "assets/monitor-DNWkbyKz.js",
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
    "url": "assets/mail-D0Gh55_h.js",
    "revision": null
  }, {
    "url": "assets/lock-CJ9-YmuQ.js",
    "revision": null
  }, {
    "url": "assets/list-checks-tC9M6ulv.js",
    "revision": null
  }, {
    "url": "assets/lightbulb-EsbUe3qa.js",
    "revision": null
  }, {
    "url": "assets/lib-CtxDr3ZM.js",
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
    "url": "assets/index-Di1NCnaZ.js",
    "revision": null
  }, {
    "url": "assets/index-BGwJAE10.css",
    "revision": null
  }, {
    "url": "assets/image-CnjTsDpH.js",
    "revision": null
  }, {
    "url": "assets/history-CyEf5VbV.js",
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
    "url": "assets/eye-off-C1ffrVTZ.js",
    "revision": null
  }, {
    "url": "assets/eye-DjPp-Kfj.js",
    "revision": null
  }, {
    "url": "assets/external-link-BbLhdudx.js",
    "revision": null
  }, {
    "url": "assets/droplets-GPOdASuS.js",
    "revision": null
  }, {
    "url": "assets/dropdown-menu-C9tFxBEg.js",
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
    "url": "assets/dist-Ds2wKeYF.js",
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
    "url": "assets/dist-BUUxpf41.js",
    "revision": null
  }, {
    "url": "assets/dialog-DF-TjA7J.js",
    "revision": null
  }, {
    "url": "assets/createLucideIcon-ZNmHFeta.js",
    "revision": null
  }, {
    "url": "assets/collapsible-D7SCSd6B.js",
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
    "url": "assets/badge-ZOc4Dmwx.js",
    "revision": null
  }, {
    "url": "assets/avatar-BkprVhaS.js",
    "revision": null
  }, {
    "url": "assets/arrow-right-CIQqIkKo.js",
    "revision": null
  }, {
    "url": "assets/arrow-left-DHD6ZMVe.js",
    "revision": null
  }, {
    "url": "assets/apiClient-DXeTGIaz.js",
    "revision": null
  }, {
    "url": "assets/alert-dialog-C66Gbtfm.js",
    "revision": null
  }, {
    "url": "assets/activity-BEaGezgI.js",
    "revision": null
  }, {
    "url": "assets/Weather-zgA4TNQK.js",
    "revision": null
  }, {
    "url": "assets/Updates-DjZQK2QJ.js",
    "revision": null
  }, {
    "url": "assets/TimeAdmin-4eBicjxp.js",
    "revision": null
  }, {
    "url": "assets/Time-DEtMwGs7.js",
    "revision": null
  }, {
    "url": "assets/ThisWeekOrder-D1_la3_F.js",
    "revision": null
  }, {
    "url": "assets/TeslaCallback-CySGT7e_.js",
    "revision": null
  }, {
    "url": "assets/SystemCard-CnttmT2b.js",
    "revision": null
  }, {
    "url": "assets/Settings-CiGGL51T.js",
    "revision": null
  }, {
    "url": "assets/SecurityCameras-BLrVOd4G.js",
    "revision": null
  }, {
    "url": "assets/Search-B8n3d8Yr.js",
    "revision": null
  }, {
    "url": "assets/SaunaLogicCard-SAVfXAix.js",
    "revision": null
  }, {
    "url": "assets/RunHistory-C7uINYjL.js",
    "revision": null
  }, {
    "url": "assets/ResetPassword-Dx17Q0ZK.js",
    "revision": null
  }, {
    "url": "assets/Projects-C6ZyFCEq.js",
    "revision": null
  }, {
    "url": "assets/ProjectWorkspace-CI-Xdfl8.js",
    "revision": null
  }, {
    "url": "assets/ProductivityDay-Bb4QD0Lx.js",
    "revision": null
  }, {
    "url": "assets/PoolTempChart-D8Yfyvt8.js",
    "revision": null
  }, {
    "url": "assets/NotionActivityChart-HtRjHLpS.js",
    "revision": null
  }, {
    "url": "assets/NotFound-T6ZA4tw4.js",
    "revision": null
  }, {
    "url": "assets/MobileBottomNav-CFqc51oz.js",
    "revision": null
  }, {
    "url": "assets/JanusFullscreen-D9_EbHZl.js",
    "revision": null
  }, {
    "url": "assets/JanusDrawer-DZ-2Ta0f.js",
    "revision": null
  }, {
    "url": "assets/Install-Dk3LDsUs.js",
    "revision": null
  }, {
    "url": "assets/Index-gcuFYduz.js",
    "revision": null
  }, {
    "url": "assets/Iaqualink-Bt7igR6A.js",
    "revision": null
  }, {
    "url": "assets/HomeSystems-tTCJ8G5T.js",
    "revision": null
  }, {
    "url": "assets/HomePage-CacWM9k3.js",
    "revision": null
  }, {
    "url": "assets/GroceryOrderRunDetail-7xJMmz33.js",
    "revision": null
  }, {
    "url": "assets/GroceryOrder-PCckn1qc.js",
    "revision": null
  }, {
    "url": "assets/GoogleCallback-Bj1nPQjb.js",
    "revision": null
  }, {
    "url": "assets/FoodDeliveryOrder-Dn1VW4Bq.js",
    "revision": null
  }, {
    "url": "assets/Family-C2bCMQhu.js",
    "revision": null
  }, {
    "url": "assets/DashboardProductivity-BtQZYXhc.js",
    "revision": null
  }, {
    "url": "assets/DashboardNav-GC56ls-3.js",
    "revision": null
  }, {
    "url": "assets/DashboardHeader-BJxSQRpQ.js",
    "revision": null
  }, {
    "url": "assets/DashboardGreeting-CP0bIduy.js",
    "revision": null
  }, {
    "url": "assets/Dashboard-CN927F6N.js",
    "revision": null
  }, {
    "url": "assets/Combination-CMf5aZD-.js",
    "revision": null
  }, {
    "url": "assets/CatalogManager-BxHWfpT1.js",
    "revision": null
  }, {
    "url": "assets/Automations-Ds1nnsQY.js",
    "revision": null
  }, {
    "url": "assets/AmazonOrder-mfUg4UZL.js",
    "revision": null
  }, {
    "url": "assets/Admin-DcVw9wCc.js",
    "revision": null
  }, {
    "url": "assets/Activity-DflO3APY.js",
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
