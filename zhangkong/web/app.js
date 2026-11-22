import init, {
  DesktopSize,
  DeviceEvent,
  Extension,
  InputTransaction,
  RotationUnit,
  SessionBuilder,
  setup,
} from "/pkg/rdp_client.js";

const SCAN = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05,
  Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13,
  KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21,
  KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, ShiftLeft: 0x2a,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  ShiftRight: 0x36, AltLeft: 0x38, Space: 0x39, F5: 0x3f,
  ArrowUp: 0xe048, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, ArrowDown: 0xe050,
  Home: 0xe047, End: 0xe04f, Delete: 0xe053, MetaLeft: 0xe05b,
};

const $ = (id) => document.getElementById(id);
const canvas = $("screen");
const stage = $("stage");
let session = null;
let wasmReady = false;
let remoteAudio = null;
let view = { scale: 1, x: 0, y: 0 };
let rightNext = false;
const held = new Set();
let stickyTimer = 0;

function hashParams() {
  return new URLSearchParams(location.hash.replace(/^#/, ""));
}

function explain(error) {
  if (error && typeof error.kind === "function") {
    const text = {
      0: "连接失败",
      1: "Windows 密码不正确",
      2: "Windows 登录失败，请检查用户名和密码",
      3: "这个账户没有远程登录权限",
      4: "和电脑的握手失败",
      5: "连不上电脑",
      6: "远程桌面协商失败",
    }[error.kind()] || "连接失败";
    const detail = error.backtrace ? error.backtrace().split("\n")[0] : "";
    return detail ? `${text}（${detail}）` : text;
  }
  return (error && error.message) || String(error || "连接失败");
}

function showGate(message) {
  $("desk").hidden = true;
  $("gate").hidden = false;
  if (message) $("loginError").textContent = message;
}

async function loadHost() {
  try {
    const response = await fetch("/api/info");
    if (!response.ok) return;
    const info = await response.json();
    $("host").hidden = false;
    $("accessPassword").textContent = info.password;
    $("lanUrl").textContent = (info.urls || []).join("\n");
    $("winUser").textContent = info.windows_user || "当前登录用户";
    $("qr").src = "/api/qr.png";
    const ready = info.rdp && info.rdp.ready;
    $("rdpState").textContent = ready
      ? "这台电脑的远程桌面已经开着。"
      : "这台电脑的远程桌面还没开，平板现在连不上。请在 Windows 设置里打开“远程桌面”。";
    $("rdpState").classList.toggle("bad", !ready);
    $("copyUrl").onclick = () => navigator.clipboard.writeText(info.connect_url);
    $("allowPort").onclick = () => fetch("/api/firewall", { method: "POST" });
  } catch {
    /* 平板上看不到本机信息 */
  }
}

function prefill() {
  const query = hashParams();
  if (query.get("k")) $("gatePassword").value = query.get("k");
  if (query.get("u")) $("user").value = query.get("u");
}

const PRESETS = [
  ["native", "跟随平板"],
  ["2560x1600", "2560 × 1600（2K）"],
  ["2560x1440", "2560 × 1440（2K）"],
  ["2048x1536", "2048 × 1536"],
  ["1920x1080", "1920 × 1080"],
  ["1600x1000", "1600 × 1000（更流畅）"],
];

function align(value, minimum) {
  const size = Math.max(minimum, Math.round(value));
  return size - (size % 4);
}

function clampBox(width, height) {
  const maxSide = 4096;
  if (width > maxSide) {
    height *= maxSide / width;
    width = maxSide;
  }
  if (height > maxSide) {
    width *= maxSide / height;
    height = maxSide;
  }
  return { width: align(width, 800), height: align(height, 600) };
}

function nativeSize() {
  const dpr = window.devicePixelRatio || 1;
  const longer = Math.max(window.screen.width, window.screen.height);
  const shorter = Math.min(window.screen.width, window.screen.height);
  // 有的浏览器报的已经是物理像素，再乘一次会变成 4K 以上。
  const alreadyPhysical = longer >= 1800 && dpr >= 1.5;
  const width = alreadyPhysical ? longer : longer * dpr;
  const height = alreadyPhysical ? shorter : shorter * dpr;
  return clampBox(width, height);
}

function presetSize(value) {
  if (!value || value === "native") return nativeSize();
  const [width, height] = value.split("x").map(Number);
  if (!width || !height) return nativeSize();
  return clampBox(width, height);
}

function currentChoice() {
  return localStorage.getItem("zk-res") || "native";
}

function fillResolutions() {
  const native = nativeSize();
  for (const select of [$("resolution"), $("deskResolution")]) {
    select.replaceChildren();
    for (const [value, label] of PRESETS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "native" ? `跟随平板（${native.width} × ${native.height}）` : label;
      select.appendChild(option);
    }
    select.value = currentChoice();
  }
  const chosen = presetSize(currentChoice());
  $("sizeHint").textContent = `将请求 ${chosen.width} × ${chosen.height} 的远程桌面。这是电脑里那块画面的大小，断开后电脑自己的屏幕不会变。2K 请选跟随平板，或直接选 2560。`;
}

function pickSize() {
  return presetSize($("resolution").value || currentChoice());
}

function layout() {
  restoreBall();
  restoreNav();
  if (!canvas.width) return;
  const bounds = stage.getBoundingClientRect();
  const fit = Math.min(bounds.width / canvas.width, bounds.height / canvas.height);
  if (view.scale < 1) view.scale = 1;
  const drawW = canvas.width * fit * view.scale;
  const drawH = canvas.height * fit * view.scale;
  const place = (pos, stageSize, drawSize) => (
    drawSize <= stageSize ? (stageSize - drawSize) / 2 : Math.min(0, Math.max(stageSize - drawSize, pos))
  );
  view.x = place(view.x, bounds.width, drawW);
  view.y = place(view.y, bounds.height, drawH);
  canvas.style.width = `${canvas.width * fit}px`;
  canvas.style.height = `${canvas.height * fit}px`;
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  restorePadPosition();
  clampPad();
  placeRemoteCursor();
}

function zoomAt(nextScale, clientX, clientY) {
  const bounds = stage.getBoundingClientRect();
  const prev = view.scale || 1;
  const scale = Math.min(4, Math.max(1, nextScale));
  const fx = clientX - bounds.left;
  const fy = clientY - bounds.top;
  const localX = (fx - view.x) / prev;
  const localY = (fy - view.y) / prev;
  view.scale = scale;
  view.x = fx - localX * scale;
  view.y = fy - localY * scale;
  layout();
}

function pointOf(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * canvas.height);
  return {
    x: Math.max(0, Math.min(canvas.width - 1, x)),
    y: Math.max(0, Math.min(canvas.height - 1, y)),
  };
}

function send(events) {
  if (!session) return;
  const tx = new InputTransaction();
  for (const event of events) tx.addEvent(event);
  session.applyInputs(tx);
}

function mouseMove(x, y) {
  send([DeviceEvent.mouseMove(x, y)]);
}

function clickButton(button, x, y) {
  send([
    DeviceEvent.mouseMove(x, y),
    DeviceEvent.mouseButtonPressed(button),
    DeviceEvent.mouseButtonReleased(button),
  ]);
}

function tapKey(code, down) {
  const scancode = SCAN[code];
  if (scancode == null) return;
  send([down ? DeviceEvent.keyPressed(scancode) : DeviceEvent.keyReleased(scancode)]);
}

function clearLatchedKeys() {
  held.clear();
  clearTimeout(stickyTimer);
  const pad = $("keyGrid");
  if (!pad) return;
  for (const item of pad.querySelectorAll(".key.on")) item.classList.remove("on");
}

// 远程桌面和电脑前的屏幕是同一个登录会话。键按下去却没松开，断开后会留在本机，微信里就打不出字。
function dropSession(target) {
  clearLatchedKeys();
  silenceRemoteAudio();
  dragging = false;
  fingerScroll = null;
  padDragging = false;
  if (!target) return Promise.resolve();
  try { target.releaseAllInputs(); } catch { /* 连接可能已经断了 */ }
  return new Promise((resolve) => {
    setTimeout(() => {
      try { target.shutdown(); } catch { /* 已经结束 */ }
      resolve();
    }, 120);
  });
}

function typeText(text) {
  for (const ch of text) {
    if (ch === "\n") {
      tapKey("Enter", true);
      tapKey("Enter", false);
      continue;
    }
    send([DeviceEvent.unicodePressed(ch), DeviceEvent.unicodeReleased(ch)]);
  }
}

function remoteAudioEngine() {
  if (remoteAudio) return remoteAudio;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  try {
    let ctx;
    try {
      // 和电脑协商的首选采样率一致。每小段各自重采样会在接缝处咔嗒一声。
      ctx = new AudioCtx({ sampleRate: 48000 });
    } catch {
      ctx = new AudioCtx();
    }
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);
    remoteAudio = { ctx, gain, nextTime: 0, sources: [] };
    return remoteAudio;
  } catch {
    return null;
  }
}

function unlockRemoteAudio() {
  const engine = remoteAudioEngine();
  if (engine && engine.ctx.state !== "running") engine.ctx.resume();
}

function resumeRemoteAudio() {
  if (remoteAudio && remoteAudio.ctx.state !== "running") remoteAudio.ctx.resume();
}

function silenceRemoteAudio() {
  if (!remoteAudio) return;
  const queued = remoteAudio.sources;
  remoteAudio.sources = [];
  remoteAudio.nextTime = 0;
  for (const source of queued) {
    try { source.stop(); } catch { /* 这一段已经播完 */ }
  }
}

function suspendRemoteAudio() {
  silenceRemoteAudio();
  if (remoteAudio && remoteAudio.ctx.state === "running") remoteAudio.ctx.suspend();
}

function bufferFromMixed(engine, mixed, sampleRate) {
  const ctxRate = engine.ctx.sampleRate;
  if (sampleRate === ctxRate) {
    const buffer = engine.ctx.createBuffer(1, mixed.length, ctxRate);
    buffer.getChannelData(0).set(mixed);
    return buffer;
  }
  const outFrames = Math.max(1, Math.round(mixed.length * ctxRate / sampleRate));
  const buffer = engine.ctx.createBuffer(1, outFrames, ctxRate);
  const out = buffer.getChannelData(0);
  const step = sampleRate / ctxRate;
  const last = mixed.length - 1;
  for (let i = 0; i < outFrames; i += 1) {
    const pos = i * step;
    const index = Math.min(Math.floor(pos), last);
    const next = Math.min(index + 1, last);
    const frac = pos - index;
    out[i] = mixed[index] + (mixed[next] - mixed[index]) * frac;
  }
  return buffer;
}

function playRemoteWave(message) {
  const engine = remoteAudioEngine();
  if (!engine) return;
  try {
    if (engine.ctx.state !== "running") engine.ctx.resume();
    const sampleRate = message.sampleRate | 0;
    const channels = message.channels | 0;
    const data = message.data;
    if (!sampleRate || channels < 1 || !data || data.length < channels * 2) return;
    const frames = Math.floor(data.length / (2 * channels));
    if (!frames) return;
    // 平板多半只有一只喇叭。左右声道若在喇叭里反相相加，会只剩下人声或只剩下伴奏。
    // 先合成一路，人声和伴奏都在。
    const mixed = new Float32Array(frames);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const scale = 1 / (32768 * channels);
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      const base = i * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        sum += view.getInt16((base + channel) * 2, true);
      }
      mixed[i] = sum * scale;
    }
    const buffer = bufferFromMixed(engine, mixed, sampleRate);
    const source = engine.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(engine.gain);
    const now = engine.ctx.currentTime;
    // 断流就从现在重新接上。积压超过一秒就丢掉旧队列，避免声音越来越落后，也不要两段叠在一起。
    if (engine.nextTime > now + 1) {
      const queued = engine.sources;
      engine.sources = [];
      for (const old of queued) {
        try { old.stop(); } catch { /* 已经结束 */ }
      }
      engine.nextTime = now + 0.06;
    } else if (!(engine.nextTime > now + 0.02)) {
      engine.nextTime = now + 0.06;
    }
    source.start(engine.nextTime);
    engine.nextTime += buffer.duration;
    engine.sources.push(source);
    source.onended = () => {
      const index = engine.sources.indexOf(source);
      if (index >= 0) engine.sources.splice(index, 1);
    };
  } catch { /* 这一包播不了就丢掉，连接继续 */ }
}

function onRemoteAudio(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "wave") {
    playRemoteWave(message);
    return;
  }
  if (message.type === "volume" && remoteAudio) {
    const left = Math.max(0, Math.min(1, Number(message.left) || 0));
    const right = Math.max(0, Math.min(1, Number(message.right) || 0));
    remoteAudio.gain.gain.setValueAtTime(Math.max(left, right), remoteAudio.ctx.currentTime);
    return;
  }
  if (message.type === "close") silenceRemoteAudio();
}

async function connect(event) {
  event.preventDefault();
  unlockRemoteAudio();
  const error = $("loginError");
  error.textContent = "";
  const button = $("connect");
  button.disabled = true;
  button.textContent = "正在连接…";
  try {
    if (!wasmReady) {
      await init();
      setup("warn");
      wasmReady = true;
    }
    const size = pickSize();
    const builder = new SessionBuilder();
    builder.username($("user").value.trim());
    builder.password($("winPassword").value);
    builder.destination("127.0.0.1:3389");
    builder.proxyAddress(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    builder.authToken($("gatePassword").value);
    builder.desktopSize(new DesktopSize(size.width, size.height));
    builder.renderCanvas(canvas);
    builder.extension(new Extension("enable_credssp", true));
    builder.extension(new Extension("audio_playback", onRemoteAudio));
    builder.setCursorStyleCallbackContext(canvas);
    builder.setCursorStyleCallback((style) => {
      noteCursorStyle(style);
    });
    session = await builder.connect();
    const desktop = session.desktopSize();
    canvas.width = desktop.width;
    canvas.height = desktop.height;
    $("deskTitle").textContent = "已连接";
    $("deskSize").textContent = `${desktop.width} × ${desktop.height}`;
    rememberCursor(desktop.width / 2, desktop.height / 2);
    $("gate").hidden = true;
    $("desk").hidden = false;
    view = { scale: 1, x: 0, y: 0 };
    layout();
    const here = cursorPoint();
    mouseMove(here.x, here.y);
    placeRemoteCursor();
    canvas.focus();
    const current = session;
    current.run().then((info) => {
      if (session !== current) return;
      finish(info && info.reason ? info.reason() : "连接已结束");
    }).catch((reason) => {
      if (session !== current) return;
      finish(explain(reason));
    });
  } catch (reason) {
    error.textContent = explain(reason);
    session = null;
  } finally {
    button.disabled = false;
    button.textContent = "连接";
  }
}

function finish(message) {
  const current = session;
  session = null;
  dropSession(current);
  suspendRemoteAudio();
  showGate(message || "");
}

function disconnect() {
  finish("已断开");
}

const pointers = new Map();
const TAP_PX = 14;
const HOLD_MS = 320;
let cursor = { x: 0, y: 0 };
let padDragging = false;
let dragging = false;
let fingerScroll = null;

function wheelLines(vertical, ticks) {
  if (!ticks) return;
  send([DeviceEvent.wheelRotations(vertical, -ticks, RotationUnit.Line)]);
}
let pressTimer = 0;
let pinch = null;

function rememberCursor(x, y) {
  if (!canvas.width || !canvas.height) return;
  cursor.x = Math.max(0, Math.min(canvas.width - 1, x));
  cursor.y = Math.max(0, Math.min(canvas.height - 1, y));
  placeRemoteCursor();
}

function placeRemoteCursor() {
  const mark = $("remoteCursor");
  const canvasRect = canvas.getBoundingClientRect();
  if (!canvas.width || !canvas.height || $("desk").hidden || !canvasRect.width || !canvasRect.height) {
    mark.classList.remove("on");
    return;
  }
  const x = canvasRect.left + (cursor.x / canvas.width) * canvasRect.width;
  const y = canvasRect.top + (cursor.y / canvas.height) * canvasRect.height;
  mark.classList.add("on");
  mark.style.transform = `translate(${x}px, ${y}px)`;
  placeTypeBox();
}

function cursorPoint() {
  return { x: Math.round(cursor.x), y: Math.round(cursor.y) };
}

function nudgeCursor(dx, dy) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !canvas.width) return cursorPoint();
  const gain = 1.35;
  rememberCursor(
    cursor.x + dx * (canvas.width / rect.width) * gain,
    cursor.y + dy * (canvas.height / rect.height) * gain,
  );
  const here = cursorPoint();
  mouseMove(here.x, here.y);
  return here;
}

function releaseDrag() {
  if (!dragging) return;
  send([DeviceEvent.mouseButtonReleased(0)]);
  dragging = false;
}

function releasePadDrag() {
  if (!padDragging) return;
  send([DeviceEvent.mouseButtonReleased(0)]);
  padDragging = false;
}

function beginTwoFinger() {
  clearTimeout(pressTimer);
  releaseDrag();
  const [a, b] = [...pointers.values()];
  pinch = {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    scale: view.scale,
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    viewX: view.x,
    viewY: view.y,
    accX: 0,
    accY: 0,
    scrolled: false,
    zoomed: false,
  };
}

function updateTwoFinger() {
  if (!pinch || pointers.size < 2) return;
  const [a, b] = [...pointers.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  for (const item of pointers.values()) {
    if (Math.hypot(item.x - item.ox, item.y - item.oy) > TAP_PX) item.moved = true;
  }
  if (pinch.dist > 24 && (pinch.zoomed || Math.abs(dist - pinch.dist) > 28)) {
    pinch.zoomed = true;
    const bounds = stage.getBoundingClientRect();
    const scale = Math.min(4, Math.max(1, pinch.scale * (dist / pinch.dist)));
    const localX = (pinch.midX - bounds.left - pinch.viewX) / pinch.scale;
    const localY = (pinch.midY - bounds.top - pinch.viewY) / pinch.scale;
    view.scale = scale;
    view.x = midX - bounds.left - localX * scale;
    view.y = midY - bounds.top - localY * scale;
    layout();
    return;
  }
  if (pinch.zoomed) return;
  pinch.accX += midX - pinch.midX;
  pinch.accY += midY - pinch.midY;
  pinch.midX = midX;
  pinch.midY = midY;
  const step = 36;
  if (Math.abs(pinch.accY) >= step && Math.abs(pinch.accY) >= Math.abs(pinch.accX)) {
    const ticks = Math.trunc(pinch.accY / step);
    pinch.accY -= ticks * step;
    pinch.scrolled = true;
    wheelLines(true, ticks);
  } else if (Math.abs(pinch.accX) >= step) {
    const ticks = Math.trunc(pinch.accX / step);
    pinch.accX -= ticks * step;
    pinch.scrolled = true;
    wheelLines(false, ticks);
  }
}

stage.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#floatBar") && !$("floatMenu").hidden) setFloatOpen(false);
  if (event.target.closest("#keys, #trackpad, #floatBar, #navBar, #typeBox, button")) return;
  if (!$("typeBox").classList.contains("docked") && document.activeElement === $("typeBox")) {
    $("typeBox").blur();
  }
  try { stage.setPointerCapture(event.pointerId); } catch { /* 指针可能已经松开 */ }
  pointers.set(event.pointerId, {
    x: event.clientX, y: event.clientY, ox: event.clientX, oy: event.clientY, moved: false,
  });
  if (pointers.size === 2) {
    fingerScroll = null;
    beginTwoFinger();
    return;
  }
  if (pointers.size > 2) {
    pinch = null;
    clearTimeout(pressTimer);
    releaseDrag();
    return;
  }
  const here = pointOf(event);
  rememberCursor(here.x, here.y);
  mouseMove(here.x, here.y);
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    const current = pointers.get(event.pointerId);
    if (!current || current.moved || dragging || pointers.size !== 1) return;
    const at = pointOf({ clientX: current.x, clientY: current.y });
    clickButton(2, at.x, at.y);
    current.consumed = true;
  }, 480);
});

stage.addEventListener("pointermove", (event) => {
  const start = pointers.get(event.pointerId);
  if (!start) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  start.x = event.clientX;
  start.y = event.clientY;
  if (pointers.size >= 2 && pinch) {
    updateTwoFinger();
    return;
  }
  const travelX = start.x - start.ox;
  const travelY = start.y - start.oy;
  const travel = Math.hypot(travelX, travelY);
  if (fingerScroll) {
    fingerScroll.acc += dy;
    const step = 18;
    if (Math.abs(fingerScroll.acc) >= step) {
      const ticks = Math.trunc(fingerScroll.acc / step);
      fingerScroll.acc -= ticks * step;
      wheelLines(true, -ticks);
    }
    return;
  }
  const here = pointOf(event);
  if (travel <= 12) {
    mouseMove(here.x, here.y);
    rememberCursor(here.x, here.y);
    return;
  }
  clearTimeout(pressTimer);
  start.moved = true;
  rememberCursor(here.x, here.y);
  if (!dragging) {
    if (Math.abs(travelY) > Math.abs(travelX) * 1.15) {
      fingerScroll = { acc: travelY };
      const step = 18;
      if (Math.abs(fingerScroll.acc) >= step) {
        const ticks = Math.trunc(fingerScroll.acc / step);
        fingerScroll.acc -= ticks * step;
        wheelLines(true, -ticks);
      }
      return;
    }
    dragging = true;
    send([DeviceEvent.mouseMove(here.x, here.y), DeviceEvent.mouseButtonPressed(0)]);
    return;
  }
  mouseMove(here.x, here.y);
});

stage.addEventListener("pointerup", (event) => {
  const start = pointers.get(event.pointerId);
  pointers.delete(event.pointerId);
  clearTimeout(pressTimer);
  if (!start) return;
  if (pinch && pointers.size < 2) {
    const travel = Math.hypot(start.x - start.ox, start.y - start.oy);
    const other = [...pointers.values()][0];
    const otherStill = !other || (!other.moved && Math.hypot(other.x - other.ox, other.y - other.oy) <= TAP_PX);
    const tap = !pinch.scrolled && !pinch.zoomed && travel <= TAP_PX && otherStill;
    for (const item of pointers.values()) item.consumed = true;
    const midX = other ? (start.x + other.x) / 2 : start.x;
    const midY = other ? (start.y + other.y) / 2 : start.y;
    const here = pointOf({ clientX: midX, clientY: midY });
    rememberCursor(here.x, here.y);
    pinch = null;
    if (tap) {
      rightNext = false;
      paintRight();
      clickButton(2, here.x, here.y);
    }
    return;
  }
  if (pointers.size > 0) return;
  if (start.consumed) {
    releaseDrag();
    return;
  }
  const here = pointOf(event);
  if (fingerScroll) {
    fingerScroll = null;
    return;
  }
  if (dragging) {
    send([DeviceEvent.mouseMove(here.x, here.y), DeviceEvent.mouseButtonReleased(0)]);
    dragging = false;
    return;
  }
  if (start.moved) return;
  rememberCursor(here.x, here.y);
  const button = rightNext ? 2 : 0;
  rightNext = false;
  paintRight();
  clickButton(button, here.x, here.y);
});

stage.addEventListener("pointercancel", () => {
  pointers.clear();
  clearTimeout(pressTimer);
  pinch = null;
  fingerScroll = null;
  releaseDrag();
});

const padPointers = new Map();
let padPinch = null;
let padMulti = null;
let padTimer = 0;
let lastPadTap = 0;
const padSurface = $("padSurface");

function chord(names) {
  const events = [];
  for (const name of names) {
    const code = SCAN[name];
    if (code == null) return;
    events.push(DeviceEvent.keyPressed(code));
  }
  for (const name of [...names].reverse()) events.push(DeviceEvent.keyReleased(SCAN[name]));
  send(events);
}

function fingerMid() {
  const pts = [...padPointers.values()];
  return {
    x: pts.reduce((sum, item) => sum + item.x, 0) / pts.length,
    y: pts.reduce((sum, item) => sum + item.y, 0) / pts.length,
  };
}

function beginPadFingers() {
  clearTimeout(padTimer);
  releasePadDrag();
  const [a, b] = [...padPointers.values()];
  padPinch = {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    accX: 0,
    accY: 0,
    scrolled: false,
    zoomed: false,
  };
}

function beginPadMulti(count) {
  clearTimeout(padTimer);
  releasePadDrag();
  const already = Boolean(padPinch && (padPinch.scrolled || padPinch.zoomed));
  padPinch = null;
  const mid = fingerMid();
  if (padMulti && !padMulti.fired) {
    padMulti.count = Math.max(padMulti.count, count);
    return;
  }
  padMulti = { count, midX: mid.x, midY: mid.y, fired: already };
}

function padSwipe(count, horizontal, positive) {
  if (count >= 4) {
    if (horizontal) chord(positive ? ["ControlLeft", "MetaLeft", "ArrowRight"] : ["ControlLeft", "MetaLeft", "ArrowLeft"]);
    else chord(positive ? ["MetaLeft", "KeyD"] : ["MetaLeft", "Tab"]);
    return;
  }
  if (horizontal) chord(positive ? ["AltLeft", "Tab"] : ["AltLeft", "ShiftLeft", "Tab"]);
  else chord(positive ? ["MetaLeft", "KeyD"] : ["MetaLeft", "Tab"]);
}

function remoteZoom(spread) {
  send([
    DeviceEvent.keyPressed(SCAN.ControlLeft),
    DeviceEvent.wheelRotations(true, spread ? 1 : -1, RotationUnit.Line),
    DeviceEvent.keyReleased(SCAN.ControlLeft),
  ]);
}

function updatePadFingers() {
  if (!padPinch || padPointers.size < 2) return;
  const [a, b] = [...padPointers.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  for (const item of padPointers.values()) {
    if (Math.hypot(item.x - item.ox, item.y - item.oy) > TAP_PX) item.moved = true;
  }
  const grew = dist - padPinch.dist;
  if (Math.abs(grew) > 26) {
    padPinch.zoomed = true;
    padPinch.dist = dist;
    remoteZoom(grew > 0);
    return;
  }
  if (padPinch.zoomed) return;
  padPinch.accX += midX - padPinch.midX;
  padPinch.accY += midY - padPinch.midY;
  padPinch.midX = midX;
  padPinch.midY = midY;
  const step = 28;
  if (Math.abs(padPinch.accY) >= step && Math.abs(padPinch.accY) >= Math.abs(padPinch.accX)) {
    const ticks = Math.trunc(padPinch.accY / step);
    padPinch.accY -= ticks * step;
    padPinch.scrolled = true;
    send([DeviceEvent.wheelRotations(true, ticks > 0 ? -1 : 1, RotationUnit.Line)]);
  } else if (Math.abs(padPinch.accX) >= step) {
    const ticks = Math.trunc(padPinch.accX / step);
    padPinch.accX -= ticks * step;
    padPinch.scrolled = true;
    send([DeviceEvent.wheelRotations(false, ticks > 0 ? -1 : 1, RotationUnit.Line)]);
  }
}

function updatePadMulti() {
  if (!padMulti || padMulti.fired || padPointers.size < 3) return;
  const mid = fingerMid();
  const dx = mid.x - padMulti.midX;
  const dy = mid.y - padMulti.midY;
  if (Math.hypot(dx, dy) < 42) return;
  padMulti.fired = true;
  for (const item of padPointers.values()) item.moved = true;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  padSwipe(padMulti.count, horizontal, (horizontal ? dx : dy) > 0);
}

padSurface.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  try { padSurface.setPointerCapture(event.pointerId); } catch { /* 指针可能已经松开 */ }
  padPointers.set(event.pointerId, {
    x: event.clientX, y: event.clientY, ox: event.clientX, oy: event.clientY,
    moved: false, doubleDrag: padPointers.size === 0 && Date.now() - lastPadTap < 320,
  });
  if (padPointers.size === 2) {
    beginPadFingers();
    return;
  }
  if (padPointers.size >= 3) {
    beginPadMulti(Math.min(padPointers.size, 4));
    return;
  }
  clearTimeout(padTimer);
  padTimer = setTimeout(() => {
    const current = padPointers.get(event.pointerId);
    if (!current || current.moved || padDragging || padPointers.size !== 1 || padPinch || padMulti) return;
    const here = cursorPoint();
    send([DeviceEvent.mouseMove(here.x, here.y), DeviceEvent.mouseButtonPressed(0)]);
    padDragging = true;
    current.consumed = true;
  }, HOLD_MS);
});

padSurface.addEventListener("pointermove", (event) => {
  const start = padPointers.get(event.pointerId);
  if (!start) return;
  event.preventDefault();
  event.stopPropagation();
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  start.x = event.clientX;
  start.y = event.clientY;
  if (padPointers.size >= 3 && padMulti) {
    updatePadMulti();
    return;
  }
  if (padPointers.size >= 2 && padPinch) {
    updatePadFingers();
    return;
  }
  const travel = Math.hypot(start.x - start.ox, start.y - start.oy);
  if (start.doubleDrag && !padDragging && travel > TAP_PX) {
    clearTimeout(padTimer);
    start.moved = true;
    start.consumed = true;
    const here = nudgeCursor(dx, dy);
    send([DeviceEvent.mouseMove(here.x, here.y), DeviceEvent.mouseButtonPressed(0)]);
    padDragging = true;
    return;
  }
  if (!padDragging && travel <= TAP_PX) return;
  clearTimeout(padTimer);
  start.moved = true;
  nudgeCursor(dx, dy);
});

padSurface.addEventListener("pointerup", (event) => {
  const start = padPointers.get(event.pointerId);
  padPointers.delete(event.pointerId);
  clearTimeout(padTimer);
  event.stopPropagation();
  if (!start) return;
  if (padMulti && padPointers.size < 3) {
    const travel = Math.hypot(start.x - start.ox, start.y - start.oy);
    const othersStill = [...padPointers.values()].every((item) => (
      !item.moved && Math.hypot(item.x - item.ox, item.y - item.oy) <= TAP_PX
    ));
    const tap = !padMulti.fired && travel <= TAP_PX && othersStill;
    const count = padMulti.count;
    for (const item of padPointers.values()) item.consumed = true;
    padMulti = null;
    padPinch = null;
    if (tap) chord(count >= 4 ? ["MetaLeft", "KeyN"] : ["MetaLeft", "KeyS"]);
    return;
  }
  if (padPinch && padPointers.size < 2) {
    const travel = Math.hypot(start.x - start.ox, start.y - start.oy);
    const other = [...padPointers.values()][0];
    const otherStill = !other || (!other.moved && Math.hypot(other.x - other.ox, other.y - other.oy) <= TAP_PX);
    const tap = !padPinch.scrolled && !padPinch.zoomed && travel <= TAP_PX && otherStill;
    for (const item of padPointers.values()) item.consumed = true;
    padPinch = null;
    if (tap) {
      const here = cursorPoint();
      rightNext = false;
      paintRight();
      clickButton(2, here.x, here.y);
    }
    return;
  }
  if (padPointers.size > 0) return;
  if (start.consumed) {
    releasePadDrag();
    lastPadTap = 0;
    return;
  }
  if (padDragging) {
    const here = cursorPoint();
    send([DeviceEvent.mouseMove(here.x, here.y), DeviceEvent.mouseButtonReleased(0)]);
    padDragging = false;
    lastPadTap = 0;
    return;
  }
  if (start.moved) {
    lastPadTap = 0;
    return;
  }
  lastPadTap = Date.now();
  const here = cursorPoint();
  const button = rightNext ? 2 : 0;
  rightNext = false;
  paintRight();
  clickButton(button, here.x, here.y);
});

padSurface.addEventListener("pointercancel", () => {
  padPointers.clear();
  clearTimeout(padTimer);
  padPinch = null;
  padMulti = null;
  releasePadDrag();
});

function setKeys(open) {
  $("keys").hidden = !open;
  $("keyToggle").classList.toggle("on", open);
  $("floatKeys").classList.toggle("on", open);
  localStorage.setItem("zk-keys", open ? "1" : "0");
  if (!open) {
    $("typeBox").blur();
    for (const name of [...held]) tapKey(name, false);
    clearLatchedKeys();
  }
  placeTypeBox();
}

function openTabletKeyboard() {
  const box = $("typeBox");
  if (box.classList.contains("docked") && document.activeElement === box) return;
  setKeys(true);
  placeTypeBox();
  box.classList.add("live", "docked");
  box.focus({ preventScroll: true });
}

function noteCursorStyle(style) {
  canvas.style.cursor = style || "default";
}

function placeTypeBox() {
  const box = $("typeBox");
  if (box.classList.contains("docked") && document.activeElement === box) return;
  const slot = $("typeSlot");
  const slotRect = slot ? slot.getBoundingClientRect() : null;
  const docked = !$("keys").hidden && slotRect && slotRect.width > 0;
  if (docked) {
    box.classList.add("live", "docked");
    box.style.left = `${slotRect.left}px`;
    box.style.top = `${slotRect.top}px`;
    box.style.width = `${slotRect.width}px`;
    box.style.height = `${Math.max(32, slotRect.height)}px`;
    return;
  }
  box.classList.remove("live", "docked");
  box.style.left = "0px";
  box.style.top = "0px";
  box.style.width = "16px";
  box.style.height = "16px";
}

function setPad(open) {
  $("trackpad").hidden = !open;
  $("padToggle").classList.toggle("on", open);
  $("floatPad").classList.toggle("on", open);
  localStorage.setItem("zk-pad-open", open ? "1" : "0");
  if (!open) {
    padPointers.clear();
    clearTimeout(padTimer);
    padPinch = null;
    padMulti = null;
    releasePadDrag();
  } else {
    requestAnimationFrame(layout);
  }
}

let padDrag = null;
let padPlaced = false;

function applyPadPosition(x, y) {
  const pad = $("trackpad");
  const bounds = stage.getBoundingClientRect();
  const padRect = pad.getBoundingClientRect();
  if (!bounds.width || !padRect.width) return;
  const maxX = Math.max(0, bounds.width - padRect.width);
  const maxY = Math.max(0, bounds.height - padRect.height);
  const left = Math.max(0, Math.min(maxX, x));
  const top = Math.max(0, Math.min(maxY, y));
  pad.style.left = `${left}px`;
  pad.style.top = `${top}px`;
  pad.style.right = "auto";
  pad.style.bottom = "auto";
  localStorage.setItem("zk-pad-pos", JSON.stringify({ x: Math.round(left), y: Math.round(top) }));
}

function restorePadPosition() {
  if (padPlaced || $("trackpad").hidden) return;
  const raw = localStorage.getItem("zk-pad-pos");
  if (!raw) {
    padPlaced = true;
    return;
  }
  if (!$("trackpad").getBoundingClientRect().width) return;
  try {
    const pos = JSON.parse(raw);
    applyPadPosition(pos.x, pos.y);
    padPlaced = true;
  } catch {
    padPlaced = true;
  }
}

function clampPad() {
  const pad = $("trackpad");
  if (pad.hidden || pad.style.left === "") return;
  const left = parseFloat(pad.style.left);
  const top = parseFloat(pad.style.top);
  if (Number.isNaN(left) || Number.isNaN(top)) return;
  applyPadPosition(left, top);
}

$("padHandle").addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) return;
  event.preventDefault();
  event.stopPropagation();
  const padRect = $("trackpad").getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  padDrag = {
    id: event.pointerId,
    dx: event.clientX - padRect.left,
    dy: event.clientY - padRect.top,
  };
  applyPadPosition(padRect.left - stageRect.left, padRect.top - stageRect.top);
  try { $("padHandle").setPointerCapture(event.pointerId); } catch { /* 指针可能已经松开 */ }
});
$("padHandle").addEventListener("pointermove", (event) => {
  if (!padDrag || event.pointerId !== padDrag.id) return;
  const stageRect = stage.getBoundingClientRect();
  applyPadPosition(event.clientX - stageRect.left - padDrag.dx, event.clientY - stageRect.top - padDrag.dy);
});
function endPadDrag(event) {
  if (!padDrag || event.pointerId !== padDrag.id) return;
  padDrag = null;
}
$("padHandle").addEventListener("pointerup", endPadDrag);
$("padHandle").addEventListener("pointercancel", endPadDrag);

function paintRight() {
  $("rightArm").classList.toggle("on", rightNext);
  $("floatRight").classList.toggle("on", rightNext);
}

function setFloatOpen(open) {
  $("floatMenu").hidden = !open;
  $("floatPeek").setAttribute("aria-expanded", open ? "true" : "false");
  $("floatPeek").setAttribute("aria-label", open ? "收起" : "菜单");
  if (open) requestAnimationFrame(clampMenu);
  else $("floatMenu").style.transform = "translateX(-50%)";
}

let ballSpot;
let ballDrag = null;
let ballHold = 0;
const ball = $("floatPeek");
ball.addEventListener("touchstart", (event) => {
  if (event.cancelable) event.preventDefault();
}, { passive: false });
ball.addEventListener("contextmenu", (event) => event.preventDefault());
ball.addEventListener("selectstart", (event) => event.preventDefault());

function readBallSpot() {
  if (ballSpot !== undefined) return ballSpot;
  try { ballSpot = JSON.parse(localStorage.getItem("zk-ball") || "null"); }
  catch { ballSpot = null; }
  return ballSpot;
}

function currentBall() {
  const bounds = stage.getBoundingClientRect();
  const rect = $("floatBar").getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - bounds.left,
    bottom: bounds.bottom - rect.bottom,
  };
}

function clampMenu() {
  const menu = $("floatMenu");
  menu.style.transform = "translateX(-50%)";
  if (menu.hidden) return;
  const stageRect = stage.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  let shift = 0;
  if (rect.left < stageRect.left + 8) shift = stageRect.left + 8 - rect.left;
  else if (rect.right > stageRect.right - 8) shift = stageRect.right - 8 - rect.right;
  if (shift) menu.style.transform = `translateX(calc(-50% + ${shift}px))`;
}

function applyBall(centerX, bottom, persist) {
  const bounds = stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const x = Math.max(15, Math.min(bounds.width - 15, centerX));
  const b = Math.max(0, Math.min(bounds.height - 30, bottom));
  const bar = $("floatBar");
  bar.style.left = `${x}px`;
  bar.style.bottom = `${b}px`;
  bar.style.transform = "translateX(-50%)";
  if (persist) {
    ballSpot = { x: x / bounds.width, b: b / bounds.height };
    localStorage.setItem("zk-ball", JSON.stringify(ballSpot));
  }
  clampMenu();
}

function restoreBall() {
  const spot = readBallSpot();
  if (!spot) return;
  const bounds = stage.getBoundingClientRect();
  applyBall(spot.x * bounds.width, spot.b * bounds.height, false);
}

function resetBallSlide() {
  ball.style.transition = "transform 200ms cubic-bezier(.22, .9, .24, 1)";
  ball.style.transform = "translate(0, 0) scale(1)";
}

ball.addEventListener("pointerdown", (event) => {
  ballDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, mode: "hold" };
  ball.style.transition = "none";
  clearTimeout(ballHold);
  ballHold = setTimeout(() => {
    if (!ballDrag || ballDrag.mode !== "hold") return;
    ballDrag.mode = "move";
    ballDrag.origin = currentBall();
    ball.style.transform = "";
    ball.classList.add("lift");
    try { navigator.vibrate(12); } catch { /* 这台设备没有震动 */ }
  }, 420);
  try { ball.setPointerCapture(event.pointerId); } catch { /* 指针可能已经松开 */ }
});
ball.addEventListener("pointermove", (event) => {
  if (!ballDrag || event.pointerId !== ballDrag.id) return;
  const dx = event.clientX - ballDrag.x;
  const dy = event.clientY - ballDrag.y;
  if (ballDrag.mode === "move") {
    applyBall(ballDrag.origin.x + dx, ballDrag.origin.bottom - dy, false);
    return;
  }
  if (ballDrag.mode === "hold" && Math.hypot(dx, dy) > 8) {
    clearTimeout(ballHold);
    ballDrag.mode = "swipe";
  }
  if (ballDrag.mode === "swipe") {
    const slideX = Math.max(-72, Math.min(72, dx));
    const slideY = Math.max(-72, Math.min(36, dy));
    const scale = 1 + Math.min(Math.hypot(slideX, slideY) / 72, 1) * 0.08;
    ball.style.transform = `translate(${slideX}px, ${slideY}px) scale(${scale})`;
  }
});
function endBall(event) {
  if (!ballDrag || event.pointerId !== ballDrag.id) return;
  const dx = event.clientX - ballDrag.x;
  const dy = event.clientY - ballDrag.y;
  const mode = ballDrag.mode;
  if (mode === "move") applyBall(ballDrag.origin.x + dx, ballDrag.origin.bottom - dy, true);
  ballDrag = null;
  clearTimeout(ballHold);
  ball.classList.remove("lift");
  resetBallSlide();
  if (mode === "move") return;
  if (mode === "swipe") {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (dy <= -36 && absY >= absX) {
      setFloatOpen(false);
      setKeys(false);
      setPad(false);
      return;
    }
    if (absX >= 36 && absX > absY) {
      setFloatOpen(false);
      if (dx < 0) setPad(true);
      else {
        summonKeyboard = true;
        openTabletKeyboard();
      }
      return;
    }
  }
  if (Math.hypot(dx, dy) < 10) setFloatOpen($("floatMenu").hidden);
}
let summonKeyboard = false;
ball.addEventListener("touchend", () => {
  if (!summonKeyboard) return;
  summonKeyboard = false;
  openTabletKeyboard();
});
ball.addEventListener("pointerup", endBall);
ball.addEventListener("pointercancel", (event) => {
  if (!ballDrag || event.pointerId !== ballDrag.id) return;
  ballDrag = null;
  clearTimeout(ballHold);
  ball.classList.remove("lift");
  resetBallSlide();
});

const nav = $("navPeek");
const navBar = $("navBar");
let navSpot;
let navDrag = null;
let navHold = 0;

function readNavSpot() {
  if (navSpot !== undefined) return navSpot;
  try { navSpot = JSON.parse(localStorage.getItem("zk-nav") || "null"); }
  catch { navSpot = null; }
  return navSpot;
}

function currentNav() {
  const bounds = stage.getBoundingClientRect();
  const rect = navBar.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - bounds.left,
    bottom: bounds.bottom - rect.bottom,
  };
}

function applyNav(centerX, bottom, persist) {
  const bounds = stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const x = Math.max(18, Math.min(bounds.width - 18, centerX));
  const b = Math.max(0, Math.min(bounds.height - 36, bottom));
  navBar.style.left = `${x}px`;
  navBar.style.bottom = `${b}px`;
  navBar.style.transform = "translateX(-50%)";
  if (persist) {
    navSpot = { x: x / bounds.width, b: b / bounds.height };
    localStorage.setItem("zk-nav", JSON.stringify(navSpot));
  }
}

function restoreNav() {
  const spot = readNavSpot();
  if (!spot) return;
  const bounds = stage.getBoundingClientRect();
  applyNav(spot.x * bounds.width, spot.b * bounds.height, false);
}

function resetNavSlide() {
  nav.style.transition = "transform 200ms cubic-bezier(.22, .9, .24, 1)";
  nav.style.transform = "translate(0, 0)";
}

let navTapAt = 0;
function openTaskView() {
  if (performance.now() - navTapAt < 700) return;
  navTapAt = performance.now();
  chord(["MetaLeft", "Tab"]);
}
nav.addEventListener("touchstart", (event) => {
  if (event.cancelable) event.preventDefault();
}, { passive: false });
nav.addEventListener("contextmenu", (event) => event.preventDefault());
nav.addEventListener("selectstart", (event) => event.preventDefault());
nav.addEventListener("mousedown", (event) => {
  event.preventDefault();
});
nav.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
  navDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, mode: "hold" };
  nav.style.transition = "none";
  clearTimeout(navHold);
  navHold = setTimeout(() => {
    if (!navDrag || navDrag.mode !== "hold") return;
    navDrag.mode = "move";
    navDrag.origin = currentNav();
    nav.style.transform = "";
    nav.classList.add("lift");
    try { navigator.vibrate(12); } catch { /* 这台设备没有震动 */ }
  }, 420);
  try { nav.setPointerCapture(event.pointerId); } catch { /* 指针可能已经松开 */ }
});
nav.addEventListener("pointermove", (event) => {
  if (!navDrag || event.pointerId !== navDrag.id) return;
  event.stopPropagation();
  const dx = event.clientX - navDrag.x;
  const dy = event.clientY - navDrag.y;
  if (navDrag.mode === "move") {
    applyNav(navDrag.origin.x + dx, navDrag.origin.bottom - dy, false);
    return;
  }
  if (navDrag.mode === "hold" && Math.hypot(dx, dy) > 8) {
    clearTimeout(navHold);
    navDrag.mode = "swipe";
  }
  if (navDrag.mode === "swipe") {
    nav.style.transform = `translate(${Math.max(-72, Math.min(72, dx))}px, ${Math.max(-72, Math.min(72, dy))}px)`;
  }
});
function endNav(event) {
  if (!navDrag || event.pointerId !== navDrag.id) return;
  const dx = event.clientX - navDrag.x;
  const dy = event.clientY - navDrag.y;
  const mode = navDrag.mode;
  if (mode === "move") applyNav(navDrag.origin.x + dx, navDrag.origin.bottom - dy, true);
  navDrag = null;
  clearTimeout(navHold);
  nav.classList.remove("lift");
  resetNavSlide();
  if (mode === "move") return;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (mode === "swipe" && dy <= -36 && absY >= absX) {
    chord(["MetaLeft", "KeyD"]);
    return;
  }
  if (mode === "swipe" && dy >= 36 && absY >= absX) {
    chord(["AltLeft", "ArrowLeft"]);
    return;
  }
  if (mode === "swipe" && absX >= 36 && absX > absY) {
    chord(dx > 0 ? ["AltLeft", "Tab"] : ["AltLeft", "ShiftLeft", "Tab"]);
    return;
  }
  if (Math.hypot(dx, dy) < 10) openTaskView();
}
nav.addEventListener("touchend", (event) => {
  if (!navDrag || navDrag.mode === "move" || navDrag.mode === "swipe") return;
  const touch = event.changedTouches && event.changedTouches[0];
  if (!touch) return;
  if (Math.hypot(touch.clientX - navDrag.x, touch.clientY - navDrag.y) >= 10) return;
  if (event.cancelable) event.preventDefault();
  openTaskView();
});
nav.addEventListener("click", (event) => {
  event.preventDefault();
  openTaskView();
});
nav.addEventListener("pointerup", endNav);
nav.addEventListener("pointercancel", (event) => {
  if (!navDrag || event.pointerId !== navDrag.id) return;
  navDrag = null;
  clearTimeout(navHold);
  nav.classList.remove("lift");
  resetNavSlide();
});

function setImmersive(on) {
  $("desk").classList.toggle("immersive", on);
  $("floatBar").hidden = !on;
  if (!on) setFloatOpen(false);
  $("fullScreen").textContent = on ? "退出全屏" : "全屏";
  requestAnimationFrame(layout);
}

async function enterFull() {
  setImmersive(true);
  const desk = $("desk");
  const request = desk.requestFullscreen || desk.webkitRequestFullscreen;
  try {
    if (request) await request.call(desk);
  } catch { /* 浏览器不让进入系统全屏时，上下栏已经收起 */ }
  layout();
}

function exitFull() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    Promise.resolve(exit.call(document)).catch(() => {});
  }
  setImmersive(false);
  layout();
}

window.addEventListener("resize", () => {
  if (document.activeElement === $("typeBox")) return;
  layout();
});
$("fitView").onclick = () => {
  view.scale = 1;
  layout();
};

stage.addEventListener("wheel", (event) => {
  if (!session || event.target.closest("#keys, #trackpad")) return;
  event.preventDefault();
  if (event.ctrlKey) {
    const next = view.scale * (event.deltaY > 0 ? 0.9 : 1.1);
    zoomAt(next, event.clientX, event.clientY);
    return;
  }
  const amount = event.deltaY > 0 ? -1 : 1;
  send([DeviceEvent.wheelRotations(true, amount, RotationUnit.Line)]);
}, { passive: false });

const KEYS = [
  ["Esc", "Escape"], ["Ctrl", "ControlLeft"], ["Alt", "AltLeft"], ["Shift", "ShiftLeft"],
  ["Win", "MetaLeft"], ["Tab", "Tab"], ["Enter", "Enter"], ["退格", "Backspace"],
  ["←", "ArrowLeft"], ["↑", "ArrowUp"], ["↓", "ArrowDown"], ["→", "ArrowRight"],
  ["Del", "Delete"], ["空格", "Space", "span"],
];

const grid = $("keyGrid");
for (const [label, code, extra] of KEYS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = extra === "span" ? "key span" : "key";
  button.textContent = label;
  const sticky = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"].includes(code);
  button.onclick = () => {
    if (!session) return;
    if (sticky) {
      if (held.has(code)) {
        held.delete(code);
        tapKey(code, false);
        button.classList.remove("on");
        if (!held.size) clearTimeout(stickyTimer);
      } else {
        held.add(code);
        tapKey(code, true);
        button.classList.add("on");
        clearTimeout(stickyTimer);
        stickyTimer = setTimeout(() => {
          for (const name of [...held]) tapKey(name, false);
          clearLatchedKeys();
        }, 4000);
      }
      return;
    }
    tapKey(code, true);
    tapKey(code, false);
    for (const name of [...held]) tapKey(name, false);
    clearLatchedKeys();
  };
  grid.appendChild(button);
}

$("keyToggle").onclick = () => {
  if ($("keys").hidden) openTabletKeyboard();
  else setKeys(false);
};
$("keyFold").onclick = () => setKeys(false);
$("padToggle").onclick = () => setPad($("trackpad").hidden);
$("padHelp").onclick = () => {
  const legend = $("padLegend");
  const open = legend.hidden;
  legend.hidden = !open;
  $("padHelp").classList.toggle("on", open);
  $("padHelp").setAttribute("aria-expanded", open ? "true" : "false");
};
for (const button of document.querySelectorAll("[data-chord]")) {
  button.addEventListener("click", () => {
    if (!session) return;
    chord(button.dataset.chord.split(","));
  });
}
for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("click", () => {
    if (!session) return;
    tapKey(button.dataset.key, true);
    tapKey(button.dataset.key, false);
  });
}
$("floatKeys").onclick = () => {
  if ($("keys").hidden) openTabletKeyboard();
  else setKeys(false);
  setFloatOpen(false);
};
$("floatPad").onclick = () => {
  setPad($("trackpad").hidden);
  setFloatOpen(false);
};
$("floatRight").onclick = () => {
  rightNext = !rightNext;
  paintRight();
};
$("floatFit").onclick = () => {
  view.scale = 1;
  layout();
  setFloatOpen(false);
};
$("padFold").onclick = () => setPad(false);
$("fullScreen").onclick = () => {
  if ($("desk").classList.contains("immersive")) exitFull();
  else enterFull();
};
$("exitFull").onclick = exitFull;
document.addEventListener("fullscreenchange", () => {
  setImmersive(Boolean(document.fullscreenElement));
});
document.addEventListener("webkitfullscreenchange", () => {
  setImmersive(Boolean(document.webkitFullscreenElement));
});
setKeys(localStorage.getItem("zk-keys") === "1");
setPad(localStorage.getItem("zk-pad-open") !== "0");
let lastRemoteDelete = 0;
function remoteDelete(forward) {
  const now = Date.now();
  if (now - lastRemoteDelete < 40) return;
  lastRemoteDelete = now;
  const code = forward ? "Delete" : "Backspace";
  tapKey(code, true);
  tapKey(code, false);
}
function flushTypeBox(box = $("typeBox")) {
  const text = box.value;
  if (!text || !session) return;
  box.value = "";
  typeText(text);
}
let composing = false;
function bindComposer(box) {
  box.addEventListener("compositionstart", () => { composing = true; });
  box.addEventListener("compositionend", () => {
    composing = false;
    flushTypeBox(box);
  });
  box.addEventListener("input", () => {
    if (!composing) flushTypeBox(box);
  });
  box.addEventListener("beforeinput", (event) => {
    if (!session) return;
    const forward = event.inputType === "deleteContentForward";
    const backward = event.inputType === "deleteContentBackward";
    if (!forward && !backward) return;
    if (composing || box.value.length > 0) return;
    event.preventDefault();
    remoteDelete(forward);
  });
  box.addEventListener("keydown", (event) => {
    if (!session || (event.key !== "Backspace" && event.key !== "Delete")) return;
    if (composing || box.value.length > 0) return;
    event.preventDefault();
    remoteDelete(event.key === "Delete");
  });
}
bindComposer($("typeBox"));
$("typeSend").onclick = flushTypeBox;
$("rightArm").onclick = () => {
  rightNext = !rightNext;
  paintRight();
};
$("login").addEventListener("submit", connect);
$("hangup").onclick = disconnect;
$("hangup2").onclick = disconnect;
$("hangup3").onclick = disconnect;

window.addEventListener("keydown", (event) => {
  if (!session || event.target.matches("input, textarea")) return;
  if (!SCAN[event.code]) return;
  event.preventDefault();
  tapKey(event.code, true);
});
window.addEventListener("keyup", (event) => {
  if (!session || event.target.matches("input, textarea")) return;
  if (!SCAN[event.code]) return;
  event.preventDefault();
  tapKey(event.code, false);
});

loadHost();
prefill();
fillResolutions();

function onResolutionPick(event) {
  const value = event.target.value;
  const wasConnected = Boolean(session);
  localStorage.setItem("zk-res", value);
  for (const select of [$("resolution"), $("deskResolution")]) {
    if (select.value !== value) select.value = value;
  }
  const chosen = presetSize(value);
  $("sizeHint").textContent = `将请求 ${chosen.width} × ${chosen.height} 的远程桌面。这是电脑里那块画面的大小，断开后电脑自己的屏幕不会变。`;
  if (!wasConnected) return;
  const old = session;
  session = null;
  dropSession(old);
  $("loginError").textContent = "正在按新分辨率重新连接…";
  $("gate").hidden = false;
  $("desk").hidden = true;
  connect({ preventDefault() {} });
}

$("resolution").addEventListener("change", onResolutionPick);
$("deskResolution").addEventListener("change", onResolutionPick);

window.addEventListener("pointerdown", resumeRemoteAudio, { passive: true });

window.addEventListener("pagehide", () => {
  const current = session;
  session = null;
  clearLatchedKeys();
  suspendRemoteAudio();
  if (!current) return;
  try { current.releaseAllInputs(); } catch { /* 页面正在关闭 */ }
  try { current.shutdown(); } catch { /* 页面正在关闭 */ }
});
