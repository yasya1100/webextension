import { verbose } from '#/common';
import { getVendor } from '#/common/ua';
import { getEngineStatus } from './engine-api';
import { getInstalledScripts, eventEmitter } from './db';

eventEmitter.on('scriptSaved', data => {
  verbose('news:scriptSaved: data', data);
  updateInstalledScripts();
});

eventEmitter.on('scriptRemoved', data => {
  verbose('news:scriptRemoved: data', data);
  updateInstalledScripts();
});

eventEmitter.on('scriptUpdated', data => {
  verbose('news:scriptUpdated: data', data);
  updateInstalledScripts();
});

const store = {
  config: {
    checkInterval: 14400000,
    notificationBaseInterval: 3600000,
    notificationIntervalAdjust: 3600000,
    notificationMaxImpressions: 10,
    notificationMaxSkip: 2,
    notificationBaseSkipInterval: 7 * 86400 * 1000, // 1 week
    notificationSkipIntervalAdjust: 0,
  },
  initDone: false,
  lastEngineVersion: 0,
  news: {},
  installedScripts: {},
  excludeByScript: {},
};

function updateInstalledScripts() {
  return getInstalledScripts().then(installed => {
    store.installedScripts = {};
    installed.forEach(id => {
      store.installedScripts[id] = 1;
    });
    verbose('news:updateInstalledScripts', store.installedScripts);
  });
}

function getLocale() {
  return browser.i18n.getUILanguage();
}

function loadConfig() {
  return browser.storage.local.get('news')
  .then(response => {
    if (response && response.news) {
      store.news = JSON.parse(response.news);
    }
  });
}

function updateExcludes() {
  const excludeByScript = {};
  Object.keys(store.news).forEach(id => {
    if (store.news[id].excludeScripts) {
      store.news[id].excludeScripts.forEach(scriptId => {
        if (typeof excludeByScript[scriptId] === 'undefined') {
          excludeByScript[scriptId] = {};
        }

        const fields = [
          'skipCount',
          'skipUpdatedAt',
          'impressionCount',
          'impressionUpdatedAt',
        ];

        fields.forEach(field => {
          if (store.news[id][field]) {
            excludeByScript[scriptId][field] = store.news[id][field];
          }
        });
      });
    }
  });
  store.excludeByScript = excludeByScript;
  verbose('updateExcludes: excludeByScript', excludeByScript);
  return Promise.resolve();
}

function saveConfig() {
  updateExcludes();
  browser.storage.local.set({
    news: JSON.stringify(store.news),
  });
}

function check() {
  checkEngine(checkNews);
}

function checkEngine(callback) {
  getEngineStatus(response => {
    callback(response);
  });
}

function checkNews(engineStatus) {
  try {
    verbose('checkNews: engineStatus', engineStatus);

    const appVersion = browser.runtime.getManifest().version;
    if (engineStatus && engineStatus.version > 0) {
      store.lastEngineVersion = engineStatus.version;
    }

    const xhr = new XMLHttpRequest();
    const url = `http://awe-api.acestream.me/news/get?vendor=${getVendor()}&locale=${getLocale()}&appVersion=${appVersion}&engineVersion=${store.lastEngineVersion}&_=${Math.random()}`;

    verbose(`news: request: url=${url}`);
    xhr.open('GET', url, true);
    xhr.timeout = 10000;
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        try {
          let updated = false;
          const remote = JSON.parse(xhr.responseText);

          const keys = Object.keys(remote);
          verbose(`news: loaded ${keys.length} news`);

          keys.forEach(id => {
            if (!store.news[id]) {
              store.news[id] = remote[id];
              updated = true;
            }
          });

          Object.keys(store.news).forEach(id => {
            if (!remote[id]) {
              delete store.news[id];
              updated = true;
            }
          });

          if (updated) {
            saveConfig();
          }
        } catch (e) {
          console.error(`news:check: error: ${e}`);
        }
      }
    };
    xhr.send();
  } catch (e) {
    console.error(`checkEngine: error: ${e}`);
  }
  window.setTimeout(check, store.config.checkInterval);
}

function shouldShowNotification(id, item) {
  if (item.read) {
    verbose(`shouldShowNotification: read: id=${id}`);
    return false;
  }

  const skipCount = item.skipCount || 0;
  if (store.config.notificationMaxSkip > 0 && skipCount >= store.config.notificationMaxSkip) {
    verbose(`shouldShowNotification: max skip: id=${id} count=${skipCount}`);
    return false;
  }

  const impressionCount = item.impressionCount || 0;
  if (store.config.notificationMaxImpressions > 0
      && impressionCount >= store.config.notificationMaxImpressions) {
    verbose(`shouldShowNotification: max impressions: id=${id} count=${impressionCount}`);
    return false;
  }

  if (item.skipUpdatedAt) {
    const skipUpdatedAt = item.skipUpdatedAt || 0;
    const skipAge = Date.now() - skipUpdatedAt;
    const skipMinAge = store.config.notificationBaseSkipInterval
      + (skipCount * store.config.notificationSkipIntervalAdjust);

    if (skipAge < skipMinAge) {
      verbose(`shouldShowNotification: skip age: id=${id} age=${skipAge} minAge=${skipMinAge}`);
      return false;
    }
  }

  if (item.impressionUpdatedAt) {
    const impressionUpdatedAt = item.impressionUpdatedAt || 0;
    const age = Date.now() - impressionUpdatedAt;
    const minAge = store.config.notificationBaseInterval
      + (impressionCount * store.config.notificationIntervalAdjust);

    if (age < minAge) {
      verbose(`shouldShowNotification: impression age: id=${id} age=${age} minAge=${minAge}`);
      return false;
    }
  }


  return true;
}

export function initialize() {
  if (!store.initDone_) {
    store.initDone_ = true;
    return loadConfig()
    .then(updateInstalledScripts)
    .then(updateExcludes)
    .then(check);
  }
}
export function importData(news) {
  verbose(`import news: count=${Object.keys(news).length}`);
  store.news = news;
  saveConfig();
}

export function getNewsForUrl(url) {
  const result = [];

  Object.keys(store.news).forEach(id => {
    let gotMatch = false;
    if (store.news[id].includes && store.news[id].includes.length) {
      for (let i = 0; i < store.news[id].includes.length; i += 1) {
        const re = new RegExp(store.news[id].includes[i]);
        if (re.test(url)) {
          verbose(`getNewsForUrl: got includes match: re=${store.news[id].includes[i]} url=${url}`);
          gotMatch = true;
          break;
        }
      }
    } else if (store.news[id].excludes && store.news[id].excludes.length) {
      gotMatch = true;
      for (let i = 0; i < store.news[id].excludes.length; i += 1) {
        const re = new RegExp(store.news[id].excludes[i]);
        if (re.test(url)) {
          verbose(`getNewsForUrl: got excludes match: re=${store.news[id].excludes[i]} url=${url}`);
          gotMatch = false;
          break;
        }
      }
    }

    if (gotMatch) {
      if (!shouldShowNotification(id, store.news[id])) {
        verbose(`getNewsForUrl: skip: id=${id} url=${url}`);
        return;
      }

      if (store.news[id].excludeBasedOnOther
        && store.news[id].excludeScripts
        && store.news[id].excludeScripts.length) {
        for (let i = 0; i < store.news[id].excludeScripts.length; i += 1) {
          const scriptId = store.news[id].excludeScripts[i];
          if (store.excludeByScript[scriptId]) {
            if (!shouldShowNotification(id, store.excludeByScript[scriptId])) {
              verbose(`getNewsForUrl: skip (other): id=${id} scriptId=${scriptId}`);
              return;
            }
          }
        }
      }

      let notifyUser = true;
      if (store.news[id].excludeScripts && store.news[id].excludeScripts.length) {
        // check all installed scripts
        verbose('getNewsForUrl: installedScripts', store.installedScripts);
        for (let i = 0; i < store.news[id].excludeScripts.length; i += 1) {
          if (store.installedScripts[store.news[id].excludeScripts[i]] === 1) {
            verbose(`getNewsForUrl: skip user notify, got installed script: id=${id} script=${store.news[id].excludeScripts[i]}`);
            notifyUser = false;
            break;
          }
        }
      }

      if (notifyUser) {
        result.push({
          id,
          title: store.news[id].title,
          text: store.news[id].text,
          btnUrl: store.news[id].btnUrl,
          btnTitle: store.news[id].btnTitle,
        });
      }
    }
  });
  return result;
}

export function onInstallButtonClicked(id) {
  if (store.news[id]) {
    // Update impression to prevent showing notification for some short time.
    // We assume that user will install userscript during this time.
    verbose(`news:onInstallButtonClicked: id=${id}`);
    store.news[id].impressionUpdatedAt = Date.now();
    saveConfig();
  }
}

export function onSkipButtonClicked(id) {
  if (store.news[id]) {
    verbose(`news:onSkipButtonClicked: id=${id}`);
    if (typeof store.news[id].skipCount === 'undefined') {
      store.news[id].skipCount = 0;
    }
    store.news[id].skipUpdatedAt = Date.now();
    store.news[id].skipCount += 1;
    saveConfig();
  }
}

export function registerImpression(id) {
  if (store.news[id]) {
    if (typeof store.news[id].impressionCount === 'undefined') {
      store.news[id].impressionCount = 0;
    }
    store.news[id].impressionUpdatedAt = Date.now();
    store.news[id].impressionCount += 1;
    saveConfig();
  }
}

export function setNotificationsConfig({ base, adjust, maxImpressions }) {
  store.config.notificationBaseInterval = base;
  store.config.notificationIntervalAdjust = adjust;
  store.config.notificationMaxImpressions = maxImpressions;
}
