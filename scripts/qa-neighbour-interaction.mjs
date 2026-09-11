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
      if (document.elementFromPoint(x, y) === canvas && map.queryRenderedFeatures([x, y], { layers: ["neighbours-fill"] }).length) return { x, y };
    }
  }
  return null;
})()`);
if (!neighbourPoint) throw new Error("No rendered neighbouring plot was found");
await mouseClick(neighbourPoint);
await waitFor("document.querySelector('.neighbour-popup')", "neighbour KG popup");
report.desktop.neighbourPopup = await evaluate("document.querySelector('.neighbour-popup').innerText");

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
