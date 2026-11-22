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
  if (!canvas.width) return;
  const bounds = stage.getBoundingClientRect();
  const fit = Math.min(bounds.width / canvas.width, bounds.height / canvas.height);
  if (view.scale < 1) view.scale = 1;
  const drawW = canvas.width * fit * view.scale;
  const drawH = canvas.height * fit * view.scale;
  if (view.scale === 1) {
    view.x = (bounds.width - drawW) / 2;
    view.y = (bounds.height - drawH) / 2;
  } else {
    view.x = Math.min(0, Math.max(bounds.width - drawW, view.x));
    view.y = Math.min(0, Math.max(bounds.height - drawH, view.y));
  }
  canvas.style.width = `${canvas.width * fit}px`;
  canvas.style.height = `${canvas.height * fit}px`;
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
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
  dragging = false;
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

async function connect(event) {
  event.preventDefault();
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
    builder.setCursorStyleCallbackContext(canvas);
    builder.setCursorStyleCallback((style) => {
      canvas.style.cursor = style || "default";
    });
    session = await builder.connect();
    const desktop = session.desktopSize();
    canvas.width = desktop.width;
    canvas.height = desktop.height;
    $("deskTitle").textContent = "已连接";
    $("deskSize").textContent = `${desktop.width} × ${desktop.height}`;
    $("gate").hidden = true;
    $("desk").hidden = false;
    view = { scale: 1, x: 0, y: 0 };
    layout();
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
  showGate(message || "");
}

function disconnect() {
  finish("已断开");
}

const pointers = new Map();
let dragging = false;
let pressTimer = 0;
let pinch = null;

stage.addEventListener("pointerdown", (event) => {
  try { stage.setPointerCapture(event.pointerId); } catch { /* 指针可能已经松开 */ }
  pointers.set(event.pointerId, {
    x: event.clientX, y: event.clientY, ox: event.clientX, oy: event.clientY, moved: false,
  });
  if (pointers.size === 1) {
    const here = pointOf(event);
    mouseMove(here.x, here.y);
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      const current = pointers.get(event.pointerId);
      if (!current || current.moved || dragging || pointers.size !== 1) return;
      const at = pointOf({ clientX: current.x, clientY: current.y });
      clickButton(2, at.x, at.y);
      current.consumed = true;
    }, 480);
    return;
  }
  clearTimeout(pressTimer);
  if (dragging) {
    send([DeviceEvent.mouseButtonReleased(0)]);
    dragging = false;
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      scale: view.scale,
      midY: (a.y + b.y) / 2,
    };
  }
});

stage.addEventListener("pointermove", (event) => {
  const start = pointers.get(event.pointerId);
  if (!start) return;
  start.x = event.clientX;
  start.y = event.clientY;
  if (pointers.size >= 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const midY = (a.y + b.y) / 2;
    if (pinch.dist > 20 && Math.abs(dist - pinch.dist) > 16) {
      view.scale = Math.min(4, Math.max(1, pinch.scale * (dist / pinch.dist)));
      layout();
    } else if (Math.abs(midY - pinch.midY) > 10) {
      send([DeviceEvent.wheelRotations(true, midY > pinch.midY ? -1 : 1, RotationUnit.Line)]);
      pinch.midY = midY;
    }
    return;
  }
  const here = pointOf(event);
  if (Math.hypot(event.clientX - start.ox, event.clientY - start.oy) <= 8) {
    mouseMove(here.x, here.y);
    return;
  }
  clearTimeout(pressTimer);
  start.moved = true;
  if (!dragging) {
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
  if (pointers.size < 2) pinch = null;
  if (!start || pointers.size > 0) return;
  const here = pointOf(event);
  if (dragging) {
    send([DeviceEvent.mouseMove(here.x, here.y), DeviceEvent.mouseButtonReleased(0)]);
    dragging = false;
    return;
  }
  if (start.consumed || start.moved) return;
  const button = rightNext ? 2 : 0;
  rightNext = false;
  $("rightArm").classList.remove("on");
  clickButton(button, here.x, here.y);
});

stage.addEventListener("pointercancel", () => {
  pointers.clear();
  clearTimeout(pressTimer);
  pinch = null;
  if (dragging) send([DeviceEvent.mouseButtonReleased(0)]);
  dragging = false;
});

window.addEventListener("resize", layout);
$("fitView").onclick = () => {
  view.scale = 1;
  layout();
};

stage.addEventListener("wheel", (event) => {
  if (!session || event.target.closest("#keys")) return;
  event.preventDefault();
  if (event.ctrlKey) {
    view.scale = Math.min(4, Math.max(1, view.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
    layout();
    return;
  }
  const amount = event.deltaY > 0 ? -1 : 1;
  send([DeviceEvent.wheelRotations(true, amount, RotationUnit.Line)]);
}, { passive: false });

const KEYS = [
  ["Esc", "Escape"], ["Tab", "Tab"], ["Ctrl", "ControlLeft"], ["Alt", "AltLeft"],
  ["Shift", "ShiftLeft"], ["Win", "MetaLeft"], ["←", "ArrowLeft"], ["↑", "ArrowUp"],
  ["↓", "ArrowDown"], ["→", "ArrowRight"], ["Enter", "Enter"], ["退格", "Backspace"],
  ["Del", "Delete"], ["空格", "Space"],
];

const grid = $("keyGrid");
for (const [label, code] of KEYS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "key";
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
  const opening = $("keys").hidden;
  $("keys").hidden = !opening;
  if (!opening) {
    for (const name of [...held]) tapKey(name, false);
    clearLatchedKeys();
  }
};
function flushTypeBox() {
  const box = $("typeBox");
  const text = box.value;
  if (!text || !session) return;
  box.value = "";
  typeText(text);
}
let composing = false;
$("typeBox").addEventListener("compositionstart", () => { composing = true; });
$("typeBox").addEventListener("compositionend", () => {
  composing = false;
  flushTypeBox();
});
$("typeBox").addEventListener("input", () => {
  if (!composing) flushTypeBox();
});
$("typeSend").onclick = flushTypeBox;
$("rightArm").onclick = () => {
  rightNext = !rightNext;
  $("rightArm").classList.toggle("on", rightNext);
};
$("login").addEventListener("submit", connect);
$("hangup").onclick = disconnect;
$("hangup2").onclick = disconnect;

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

window.addEventListener("pagehide", () => {
  const current = session;
  session = null;
  clearLatchedKeys();
  if (!current) return;
  try { current.releaseAllInputs(); } catch { /* 页面正在关闭 */ }
  try { current.shutdown(); } catch { /* 页面正在关闭 */ }
});
