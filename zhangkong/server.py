"""掌控：在这台电脑上提供网页，并把 IronRDP 接到本机远程桌面。"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import socket
import sys
import webbrowser
from pathlib import Path

from aiohttp import web

from . import rdcleanpath

WEB = Path(__file__).resolve().parent / "web"
_INSTANCE_MUTEX = None


def install_dir() -> Path:
    """配置放在软件旁边。打包之后不能写到临时解压目录里。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


CONFIG_PATH = install_dir() / "config.json"
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
}


def load_config() -> dict:
    data = {}
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            data = {}
    password = str(data.get("password") or "").strip()
    if not password:
        password = f"{secrets.randbelow(1_000_000):06d}"
    try:
        port = int(data.get("port") or 8765)
    except (TypeError, ValueError):
        port = 8765
    port = min(65535, max(1, port))
    name = str(data.get("name") or socket.gethostname() or "我的电脑").strip()[:40]
    cfg = {"password": password, "port": port, "name": name}
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def lan_ips() -> list[str]:
    """默认路由那块网卡放在最前面。平板和电脑插在同一台路由时，用的就是这个地址。"""
    primary = ""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            primary = sock.getsockname()[0]
        finally:
            sock.close()
    except OSError:
        primary = ""
    found: list[str] = []

    def add(ip: str) -> None:
        if ip and ip not in found and not ip.startswith("127.") and not ip.startswith("169.254."):
            found.append(ip)

    if primary:
        add(primary)
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except OSError:
        pass
    return found


def windows_user() -> str:
    return os.environ.get("USERNAME") or ""


def rdp_status() -> dict:
    enabled = False
    running = False
    listening = False
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Terminal Server"
        ) as key:
            enabled = winreg.QueryValueEx(key, "fDenyTSConnections")[0] == 0
    except OSError:
        enabled = False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Services\TermService") as key:
            running = winreg.QueryValueEx(key, "Start")[0] != 4
    except OSError:
        running = False
    try:
        probe = socket.create_connection(("127.0.0.1", 3389), timeout=0.4)
        probe.close()
        listening = True
    except OSError:
        listening = False
    return {"enabled": enabled, "service": running, "listening": listening, "ready": enabled and listening}


def is_localhost(request: web.Request) -> bool:
    return (request.remote or "") in {"127.0.0.1", "::1"}


class AppState:
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.viewers = 0

    def connect_url(self) -> str:
        ips = lan_ips()
        host = ips[0] if ips else "127.0.0.1"
        user = windows_user()
        password = self.cfg["password"]
        fragment = f"k={password}"
        if user:
            from urllib.parse import quote

            fragment += f"&u={quote(user)}"
        return f"http://{host}:{self.cfg['port']}/#{fragment}"

    def info(self) -> dict:
        ips = lan_ips()
        port = self.cfg["port"]
        urls = [f"http://{ip}:{port}" for ip in ips] or [f"http://127.0.0.1:{port}"]
        return {
            "name": self.cfg["name"],
            "port": port,
            "password": self.cfg["password"],
            "windows_user": windows_user(),
            "urls": urls,
            "connect_url": self.connect_url(),
            "viewers": self.viewers,
            "rdp": rdp_status(),
        }


def build_app(state: AppState) -> web.Application:
    app = web.Application()
    app["state"] = state
    app.router.add_get("/", page)
    app.router.add_get("/app.js", page)
    app.router.add_get("/app.css", page)
    app.router.add_get("/pkg/{name}", pkg)
    app.router.add_get("/api/health", health)
    app.router.add_get("/api/info", info)
    app.router.add_get("/api/qr.png", qr_image)
    app.router.add_post("/api/firewall", firewall)
    app.router.add_get("/ws", websocket)
    return app


def no_store(response: web.StreamResponse) -> web.StreamResponse:
    response.headers["Cache-Control"] = "no-store"
    return response


async def page(request: web.Request) -> web.Response:
    name = "index.html" if request.path == "/" else request.path.rsplit("/", 1)[-1]
    if name not in {"index.html", "app.js", "app.css"}:
        raise web.HTTPNotFound()
    path = WEB / name
    return no_store(web.FileResponse(path, headers={"Content-Type": MIME[path.suffix]}))


async def pkg(request: web.Request) -> web.Response:
    name = request.match_info["name"]
    if name not in {"rdp_client.js", "rdp_client_bg.wasm"}:
        raise web.HTTPNotFound()
    path = WEB / "pkg" / name
    if not path.exists():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Content-Type": MIME[path.suffix], "Cache-Control": "no-cache"})


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "name": "掌控"})


async def info(request: web.Request) -> web.Response:
    if not is_localhost(request):
        raise web.HTTPForbidden(text="仅本机可查看连接信息")
    return web.json_response(request.app["state"].info())


async def qr_image(request: web.Request) -> web.Response:
    if not is_localhost(request):
        raise web.HTTPForbidden(text="仅本机可获取二维码")
    import io

    import qrcode

    state: AppState = request.app["state"]
    image = qrcode.make(state.connect_url())
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return web.Response(body=buf.getvalue(), content_type="image/png", headers={"Cache-Control": "no-store"})


async def firewall(request: web.Request) -> web.Response:
    if not is_localhost(request):
        raise web.HTTPForbidden(text="只能在电脑本机操作")
    import ctypes

    port = int(request.app["state"].cfg["port"])
    params = (
        "advfirewall firewall add rule "
        f'name="掌控 {port}" dir=in action=allow protocol=TCP localport={port}'
    )
    code = int(ctypes.windll.shell32.ShellExecuteW(None, "runas", "netsh", params, None, 1))
    return web.json_response({"ok": code > 32, "code": code})


async def websocket(request: web.Request) -> web.WebSocketResponse:
    state: AppState = request.app["state"]
    ws = web.WebSocketResponse(max_msg_size=16 * 1024 * 1024, heartbeat=30)
    await ws.prepare(request)
    loop = asyncio.get_running_loop()
    pump: rdcleanpath.TlsPump | None = None
    secure = None
    try:
        first = await read_first_pdu(ws)
        request_pdu = rdcleanpath.parse_request(first)
        if not same_secret(request_pdu.proxy_auth, state.cfg["password"]):
            await ws.send_bytes(rdcleanpath.build_error(401))
            await ws.close()
            return ws
        rdcleanpath.local_target(request_pdu.destination)
        secure, confirm, certs = await asyncio.to_thread(rdcleanpath.handshake, request_pdu.x224)
        await ws.send_bytes(rdcleanpath.build_response("127.0.0.1:3389", confirm, certs))
        state.viewers += 1
        print(f"[连接] {request.remote} 已进入远程桌面，当前 {state.viewers} 个")

        def on_data(data: bytes) -> None:
            asyncio.run_coroutine_threadsafe(send_or_close(ws, data), loop)

        def on_close() -> None:
            asyncio.run_coroutine_threadsafe(ws.close(), loop)

        pump = rdcleanpath.TlsPump(secure, on_data, on_close)
        pump.start()
        async for msg in ws:
            if msg.type == web.WSMsgType.BINARY:
                pump.send_later(msg.data)
            elif msg.type in (web.WSMsgType.CLOSE, web.WSMsgType.CLOSING, web.WSMsgType.ERROR):
                break
    except rdcleanpath.ProtocolError as exc:
        print(f"[拒绝] {request.remote}：{exc}")
        if not ws.closed:
            try:
                await ws.send_bytes(rdcleanpath.build_error(400))
            except Exception:
                pass
    except Exception as exc:
        print(f"[中断] {request.remote}：{exc}")
        if not ws.closed:
            try:
                await ws.send_bytes(rdcleanpath.build_error(502))
            except Exception:
                pass
    finally:
        if pump is not None:
            pump.close()
            state.viewers = max(0, state.viewers - 1)
            print(f"[断开] {request.remote}，剩余 {state.viewers} 个")
        elif secure is not None:
            try:
                secure.close()
            except OSError:
                pass
        if not ws.closed:
            await ws.close()
    return ws


def same_secret(got: str, expected: str) -> bool:
    try:
        return secrets.compare_digest(got, expected)
    except Exception:
        return False


async def send_or_close(ws: web.WebSocketResponse, data: bytes) -> None:
    if ws.closed:
        return
    try:
        await ws.send_bytes(data)
    except Exception:
        await ws.close()


async def read_first_pdu(ws: web.WebSocketResponse) -> bytes:
    buf = bytearray()
    while True:
        msg = await ws.receive()
        if msg.type != web.WSMsgType.BINARY:
            raise rdcleanpath.ProtocolError("没有收到连接请求")
        buf.extend(msg.data)
        if len(buf) > 256 * 1024:
            raise rdcleanpath.ProtocolError("连接请求过大")
        total = rdcleanpath.pdu_complete_length(buf)
        if total is not None:
            return bytes(buf[:total])


def print_banner(state: AppState) -> None:
    info_data = state.info()
    ready = "已开启" if info_data["rdp"]["ready"] else "还没开，平板暂时连不上"
    print()
    print("  掌控已启动")
    print("  平板和电脑要在同一台路由上。电脑插网线、平板连 Wi-Fi 也可以。")
    print(f"  本机页面  http://127.0.0.1:{state.cfg['port']}")
    for url in info_data["urls"]:
        print(f"  平板地址  {url}")
    print(f"  访问密码  {state.cfg['password']}")
    print(f"  远程桌面  {ready}")
    print("  这个窗口请保持打开，可以最小化。连上后，电脑前的屏幕会锁定。")
    print()


async def open_browser_later(port: int) -> None:
    await asyncio.sleep(0.6)
    webbrowser.open(f"http://127.0.0.1:{port}")


def prepare_console() -> None:
    if os.name != "nt":
        return
    import ctypes

    ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    ctypes.windll.kernel32.SetConsoleCP(65001)
    ctypes.windll.kernel32.SetConsoleTitleW("掌控")


def service_is_ours(port: int) -> bool:
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=0.8) as resp:
            if resp.status != 200:
                return False
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return False
    return data.get("ok") is True and data.get("name") == "掌控"


def grab_instance() -> bool:
    """同一台电脑只留一个掌控。第二次双击只打开网页。"""
    global _INSTANCE_MUTEX
    if os.name != "nt":
        return True
    import ctypes

    kernel32 = ctypes.windll.kernel32
    kernel32.SetLastError(0)
    handle = kernel32.CreateMutexW(None, False, "Local\\ZhangKongRemoteDesktop")
    if kernel32.GetLastError() == 183:
        if handle:
            kernel32.CloseHandle(handle)
        return False
    _INSTANCE_MUTEX = handle
    return True


def open_existing(port: int) -> None:
    print("掌控已经在运行，正在打开页面。")
    webbrowser.open(f"http://127.0.0.1:{port}")


def run_check() -> int:
    # 只做到 TLS，不发送 Windows 账号，不会登录，也不会锁屏幕。
    sample = bytes.fromhex("030000130ee000000000000100080003000000")
    secure = None
    try:
        secure, confirm, certs = rdcleanpath.handshake(sample)
        made = rdcleanpath.build_response("127.0.0.1:3389", confirm, certs)
        if rdcleanpath.pdu_complete_length(made) != len(made):
            print("响应编码长度不对")
            return 1
        print(f"本机远程桌面握手成功，确认包 {len(confirm)} 字节，证书 {len(certs[0])} 字节")
        return 0
    except Exception as exc:
        print(f"本机远程桌面握手失败：{exc}")
        return 1
    finally:
        if secure is not None:
            try:
                secure.close()
            except OSError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="掌控：平板浏览器控制这台电脑")
    parser.add_argument("--check", action="store_true", help="只测试本机远程桌面握手，不登录")
    parser.add_argument("--no-browser", action="store_true", help="启动时不打开本机浏览器")
    args = parser.parse_args()
    if args.check:
        sys.exit(run_check())
    prepare_console()
    cfg = load_config()
    if service_is_ours(cfg["port"]) or not grab_instance():
        open_existing(cfg["port"])
        return
    state = AppState(cfg)
    app = build_app(state)
    print_banner(state)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    if not args.no_browser:
        loop.create_task(open_browser_later(cfg["port"]))
    try:
        web.run_app(app, host="0.0.0.0", port=cfg["port"], print=None, loop=loop)
    except OSError as exc:
        print(f"端口 {cfg['port']} 无法打开：{exc}")
        print("如果已经开着一个掌控，先关掉那个窗口。")
        if getattr(sys, "frozen", False):
            input("按回车关闭。")
        sys.exit(1)


if __name__ == "__main__":
    main()
