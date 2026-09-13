const BASE_URL = process.argv[2] || "http://127.0.0.1:4173/";
const DEBUG_PORT = Number(process.argv[3] || 9223);

const target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new`, { method: "PUT" }).then((response) => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const events = new Map();
let sequence = 0;

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
    return;
  }
  (events.get(message.method) || []).forEach((listener) => listener(message.params));
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

function on(method, listener) {
  const listeners = events.get(method) || [];
  listeners.push(listener);
  events.set(method, listeners);
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Browser evaluation failed");
  return response.result.value;
}

async function waitFor(expression, label, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function click(expression) {
  const clicked = await evaluate(`(() => { const element = ${expression}; if (!element) return false; element.click(); return true; })()`);
  if (!clicked) throw new Error(`Element not found: ${expression}`);
}

async function mouseClick(point) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

const pageErrors = [];
const networkFailures = [];
on("Runtime.exceptionThrown", ({ exceptionDetails }) => pageErrors.push(exceptionDetails.exception?.description || exceptionDetails.text));
on("Log.entryAdded", ({ entry }) => { if (entry.level === "error") pageErrors.push(entry.text); });
on("Network.loadingFailed", ({ errorText, canceled }) => { if (!canceled && errorText !== "net::ERR_ABORTED") networkFailures.push(errorText); });

await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable"), send("Log.enable")]);
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    let mapboxValue;
    Object.defineProperty(window, "mapboxgl", {
      configurable: true,
      get() { return mapboxValue; },
      set(value) {
        if (value && value.Map && !value.Map.__qaWrapped) {
          const OriginalMap = value.Map;
          class CapturedMap extends OriginalMap {
            constructor(...args) {
              super(...args);
              window.__qaMap = this;
            }
          }
          CapturedMap.__qaWrapped = true;
          value.Map = CapturedMap;
        }
        mapboxValue = value;
      }
    });
  })();`
});
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const qaUrl = `${BASE_URL}${BASE_URL.includes("?") ? "&" : "?"}qa=1`;
await send("Page.navigate", { url: qaUrl });
await waitFor("window.__qaMap && window.__qaMap.getSource('plots') && document.querySelectorAll('.site-tab').length === 2", "Mapbox map", 45000);

const report = { desktop: {}, stress: {}, mobile: {} };

await click("document.querySelector('[data-site=\"site1\"]')");
await click("document.querySelector('[data-filter-mode=\"1+2\"]')");
await waitFor("document.querySelectorAll('.result-item').length > 0 && !document.querySelector('.similarity-loading:not(.hidden)')", "Site 1 results");
report.desktop.site1Results = await evaluate("document.querySelectorAll('.result-item').length");
report.desktop.site1FilterCounts = { similarPlots: report.desktop.site1Results };
await click("document.querySelector('[data-filter-mode=\"1+2+3\"]')");
await waitFor("document.querySelectorAll('.result-item').length > 0 && !document.querySelector('.similarity-loading:not(.hidden)')", "Site 1 neighbour-filter results");
report.desktop.site1FilterCounts.similarNeighbours = await evaluate("document.querySelectorAll('.result-item').length");
await click("document.querySelector('[data-filter-mode=\"1+2+3+4\"]')");
await waitFor("document.querySelectorAll('.result-item').length > 0 && !document.querySelector('.similarity-loading:not(.hidden)')", "Site 1 road-filter results");
report.desktop.site1FilterCounts.similarRoadFrontage = await evaluate("document.querySelectorAll('.result-item').length");
if (JSON.stringify(Object.values(report.desktop.site1FilterCounts)) !== JSON.stringify([66, 48, 8])) {
  throw new Error(`Unexpected Site 1 filter counts: ${JSON.stringify(report.desktop.site1FilterCounts)}`);
}
await click("document.querySelector('[data-filter-mode=\"1+2\"]')");
await waitFor("document.querySelectorAll('.result-item').length === 66 && !document.querySelector('.similarity-loading:not(.hidden)')", "Site 1 base results restored");
await click("document.querySelector('.result-item')");
await waitFor("document.querySelector('.neighbour-summary') && window.__qaMap.getSource('neighbours')._data.features.length > 0", "Site 1 neighbours", 30000);
report.desktop.site1Neighbours = await evaluate("window.__qaMap.getSource('neighbours')._data.features.length");
report.desktop.summary = await evaluate("document.querySelector('.neighbour-summary').innerText");
await new Promise((resolve) => setTimeout(resolve, 1500));

const neighbourPoint = await evaluate(`(() => {
  const map = window.__qaMap;
  const canvas = map.getCanvas();
  for (let y = 90; y < canvas.clientHeight - 80; y += 8) {
    for (let x = 390; x < canvas.clientWidth - 30; x += 8) {
      const features = map.queryRenderedFeatures([x, y], { layers: ["neighbours-fill"] });
      if (document.elementFromPoint(x, y) !== canvas || !features.length) continue;
      try {
        if (JSON.parse(features[0].properties.gfa_schemes_json || "[]").length > 1) return { x, y };
      } catch {}
    }
  }
  return null;
})()`);
if (!neighbourPoint) throw new Error("No rendered neighbouring plot was found");
await mouseClick(neighbourPoint);
await waitFor("document.querySelector('.neighbour-popup') && document.querySelectorAll('.gfa-scheme-tab').length > 1", "multi-scheme neighbour KG popup");
if (!await evaluate("document.querySelector('.neighbour-popup-shell').classList.contains('mapboxgl-popup-anchor-bottom')")) {
  throw new Error("Neighbour popup is not anchored above the selected plot");
}
report.desktop.neighbourPopup = await evaluate("document.querySelector('.neighbour-popup').innerText");
report.desktop.gfaSchemeCount = await evaluate("document.querySelectorAll('.gfa-scheme-tab').length");
await click("document.querySelectorAll('.gfa-scheme-tab')[1]");
await waitFor("document.querySelectorAll('.gfa-scheme-tab')[1].getAttribute('aria-selected') === 'true' && !document.querySelectorAll('.gfa-scheme-panel')[1].classList.contains('hidden')", "second GFA scheme");
report.desktop.secondGfaScheme = await evaluate("document.querySelectorAll('.gfa-scheme-panel')[1].innerText");
report.desktop.schemeIds = await evaluate("[...document.querySelectorAll('.gfa-scheme-panel')].slice(0, 2).map((panel) => panel.querySelector('.kg-id').textContent)");
if (report.desktop.schemeIds[0] === report.desktop.schemeIds[1]) throw new Error("GFA scheme IDs are not distinguishable");
report.desktop.popupViewport = await evaluate(`(() => {
  const popup = document.querySelector('.neighbour-popup-shell');
  const scroller = popup.querySelector('.neighbour-popup');
  const rect = popup.getBoundingClientRect();
  return {
    popupHeight: Math.round(rect.height),
    viewportHeight: window.innerHeight,
    scrollAreaHeight: scroller.clientHeight,
    scrollContentHeight: scroller.scrollHeight,
    internallyScrollable: scroller.scrollHeight > scroller.clientHeight
  };
})()`);
if (report.desktop.popupViewport.popupHeight >= report.desktop.popupViewport.viewportHeight || !report.desktop.popupViewport.internallyScrollable) {
  throw new Error(`Desktop neighbour popup is not viewport-safe: ${JSON.stringify(report.desktop.popupViewport)}`);
}

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await evaluate("window.__qaMap.resize(); true");
await new Promise((resolve) => setTimeout(resolve, 400));
report.mobile.popupViewport = await evaluate(`(() => {
  const popup = document.querySelector('.neighbour-popup-shell');
  const scroller = popup.querySelector('.neighbour-popup');
  const rect = popup.getBoundingClientRect();
  return {
    popupWidth: Math.round(rect.width),
    popupHeight: Math.round(rect.height),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollAreaHeight: scroller.clientHeight,
    scrollContentHeight: scroller.scrollHeight,
    internallyScrollable: scroller.scrollHeight > scroller.clientHeight
  };
})()`);
if (report.mobile.popupViewport.popupWidth > report.mobile.popupViewport.viewportWidth - 18 || report.mobile.popupViewport.popupHeight >= report.mobile.popupViewport.viewportHeight || !report.mobile.popupViewport.internallyScrollable) {
  throw new Error(`Mobile neighbour popup is not viewport-safe: ${JSON.stringify(report.mobile.popupViewport)}`);
}
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await evaluate("window.__qaMap.resize(); true");
await new Promise((resolve) => setTimeout(resolve, 300));

const blankPoint = await evaluate(`(() => {
  const map = window.__qaMap;
  const canvas = map.getCanvas();
  const layers = ["neighbours-fill", "plots-fill", "reference-labels", "reference-marker"];
  for (let y = 90; y < canvas.clientHeight - 80; y += 20) {
    for (let x = 400; x < canvas.clientWidth - 20; x += 20) {
      if (document.elementFromPoint(x, y) === canvas && !map.queryRenderedFeatures([x, y], { layers }).length) return { x, y };
    }
  }
  return null;
})()`);
if (!blankPoint) throw new Error("No empty map point was found");
await mouseClick(blankPoint);
await waitFor("!document.querySelector('.map-popup') && window.__qaMap.getSource('neighbours')._data.features.length === 0", "blank-click dismissal");
report.desktop.blankClickCleared = true;

await evaluate(`(() => {
  const items = [...document.querySelectorAll('.result-item')];
  items[0].click(); items[1].click(); items[2].click();
})()`);
await waitFor("document.querySelector('.neighbour-summary') && window.__qaMap.getSource('neighbours')._data.features.length > 0", "rapid candidate switching");
report.stress.rapidCandidateSwitch = true;
report.stress.finalNeighbourCount = await evaluate("window.__qaMap.getSource('neighbours')._data.features.length");

await click("document.querySelector('[data-site=\"site2\"]')");
await click("document.querySelector('[data-filter-mode=\"1+2+3+4\"]')");
await waitFor("document.querySelector('.similarity-loading.hidden') && document.querySelectorAll('.result-item').length === 0", "Site 2 zero-result strict mode");
report.stress.site2StrictResults = 0;
await click("document.querySelector('[data-filter-mode=\"1+2\"]')");
await waitFor("document.querySelectorAll('.result-item').length > 0 && !document.querySelector('.similarity-loading:not(.hidden)')", "Site 2 results");
await click("document.querySelector('.result-item')");
await waitFor("document.querySelector('.neighbour-summary') && window.__qaMap.getSource('neighbours')._data.features.length > 0", "Site 2 neighbours", 30000);
report.stress.site2Neighbours = await evaluate("window.__qaMap.getSource('neighbours')._data.features.length");

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Page.reload", { ignoreCache: true });
await waitFor("window.__qaMap && window.__qaMap.getSource('plots') && document.querySelector('[data-filter-mode=\"1+2\"]')", "mobile map", 45000);
await click("document.querySelector('[data-site=\"site1\"]')");
await click("document.querySelector('[data-filter-mode=\"1+2\"]')");
await waitFor("document.querySelectorAll('.result-item').length > 0 && !document.querySelector('.similarity-loading:not(.hidden)')", "mobile results");
await click("document.querySelector('.result-item')");
await waitFor("document.querySelector('.neighbour-summary') && window.__qaMap.getSource('neighbours')._data.features.length > 0", "mobile neighbours", 30000);
report.mobile.neighbours = await evaluate("window.__qaMap.getSource('neighbours')._data.features.length");
report.mobile.horizontalOverflow = await evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth");

report.pageErrors = [...new Set(pageErrors)].filter((message) => !/favicon/i.test(message));
report.networkFailures = [...new Set(networkFailures)];
console.log(JSON.stringify(report, null, 2));
if (report.pageErrors.length || report.networkFailures.length || report.mobile.horizontalOverflow) process.exitCode = 1;
socket.close();
