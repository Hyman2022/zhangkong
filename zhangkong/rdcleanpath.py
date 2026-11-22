"""RDCleanPath：浏览器里的 IronRDP 连上本机远程桌面之前的那一下握手。

协议字段来自 IronRDP 的 ironrdp-rdcleanpath。代理只允许转到 127.0.0.1:3389。
"""

from __future__ import annotations

import select
import socket
import ssl
import threading
from dataclasses import dataclass

VERSION_1 = 3390
TAG_SEQUENCE = 0x30
TAG_INTEGER = 0x02
TAG_OCTET_STRING = 0x04
TAG_UTF8STRING = 0x0C

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ProtocolError(Exception):
    pass


def _encode_length(length: int) -> bytes:
    if length < 0x80:
        return bytes((length,))
    raw = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes((0x80 | len(raw),)) + raw


def _wrap(tag: int, content: bytes) -> bytes:
    return bytes((tag,)) + _encode_length(len(content)) + content


def _encode_integer(value: int) -> bytes:
    if value < 0:
        raise ProtocolError("整数不能是负数")
    if value == 0:
        body = b"\x00"
    else:
        body = value.to_bytes((value.bit_length() + 7) // 8, "big")
        if body[0] & 0x80:
            body = b"\x00" + body
    return _wrap(TAG_INTEGER, body)


def _decode_length(buf: bytes, offset: int) -> tuple[int, int]:
    first = buf[offset]
    if first < 0x80:
        return first, 1
    count = first & 0x7F
    if count == 0 or offset + 1 + count > len(buf):
        raise ProtocolError("DER 长度不完整")
    length = int.from_bytes(buf[offset + 1 : offset + 1 + count], "big")
    return length, 1 + count


def _decode_tlv(buf: bytes, offset: int = 0) -> tuple[int, bytes, int]:
    if offset >= len(buf):
        raise ProtocolError("DER 数据太短")
    tag = buf[offset]
    length, used = _decode_length(buf, offset + 1)
    start = offset + 1 + used
    end = start + length
    if end > len(buf):
        raise ProtocolError("DER 内容被截断")
    return tag, buf[start:end], end - offset


def _decode_children(buf: bytes) -> list[tuple[int, bytes]]:
    items = []
    offset = 0
    while offset < len(buf):
        tag, value, size = _decode_tlv(buf, offset)
        items.append((tag, value))
        offset += size
    return items


def _decode_integer(buf: bytes) -> int:
    return int.from_bytes(buf, "big") if buf else 0


def pdu_complete_length(buf: bytes) -> int | None:
    """缓冲还不够时返回 None。"""
    if not buf:
        return None
    if buf[0] != TAG_SEQUENCE:
        raise ProtocolError("RDCleanPath 不是 SEQUENCE")
    if len(buf) < 2:
        return None
    try:
        length, used = _decode_length(buf, 1)
    except ProtocolError:
        return None
    total = 1 + used + length
    if len(buf) < total:
        return None
    return total


@dataclass
class CleanPathRequest:
    destination: str
    proxy_auth: str
    x224: bytes
    preconnection_blob: str | None = None


def parse_request(data: bytes) -> CleanPathRequest:
    tag, body, size = _decode_tlv(data)
    if tag != TAG_SEQUENCE or size != len(data):
        raise ProtocolError("RDCleanPath 请求格式不对")
    version = None
    destination = None
    proxy_auth = ""
    x224 = None
    blob = None
    for child_tag, child in _decode_children(body):
        number = child_tag & 0x1F
        if number == 0:
            inner_tag, inner, _ = _decode_tlv(child)
            if inner_tag != TAG_INTEGER:
                raise ProtocolError("版本字段不对")
            version = _decode_integer(inner)
        elif number == 2:
            _inner_tag, inner, _ = _decode_tlv(child)
            destination = inner.decode("utf-8")
        elif number == 3:
            _inner_tag, inner, _ = _decode_tlv(child)
            proxy_auth = inner.decode("utf-8")
        elif number == 5:
            _inner_tag, inner, _ = _decode_tlv(child)
            blob = inner.decode("utf-8")
        elif number == 6:
            inner_tag, inner, _ = _decode_tlv(child)
            if inner_tag != TAG_OCTET_STRING:
                raise ProtocolError("握手数据不对")
            x224 = inner
    if version != VERSION_1:
        raise ProtocolError(f"不支持的 RDCleanPath 版本：{version}")
    if not destination or x224 is None:
        raise ProtocolError("请求里缺少目标或握手数据")
    return CleanPathRequest(destination, proxy_auth, x224, blob)


def local_target(destination: str) -> tuple[str, int]:
    text = destination.strip()
    if text.startswith("["):
        end = text.find("]")
        host = text[1:end]
        port_text = text[end + 1 :]
        port = int(port_text[1:]) if port_text.startswith(":") and port_text[1:].isdigit() else 3389
    elif ":" in text:
        host, port_text = text.rsplit(":", 1)
        port = int(port_text) if port_text.isdigit() else 3389
    else:
        host, port = text, 3389
    if host.lower() not in LOCAL_HOSTS or port != 3389:
        raise ProtocolError("只允许连接这台电脑自己的远程桌面")
    return "127.0.0.1", 3389


def build_response(server_addr: str, x224: bytes, certs: list[bytes]) -> bytes:
    parts = [
        _wrap(0xA0, _encode_integer(VERSION_1)),
        _wrap(0xA6, _wrap(TAG_OCTET_STRING, x224)),
        _wrap(0xA7, _wrap(TAG_SEQUENCE, b"".join(_wrap(TAG_OCTET_STRING, cert) for cert in certs))),
        _wrap(0xA9, _wrap(TAG_UTF8STRING, server_addr.encode("utf-8"))),
    ]
    return _wrap(TAG_SEQUENCE, b"".join(parts))


def build_error(http_status: int = 502) -> bytes:
    error = _wrap(
        TAG_SEQUENCE,
        _wrap(0xA0, _encode_integer(1)) + _wrap(0xA1, _encode_integer(http_status)),
    )
    return _wrap(
        TAG_SEQUENCE,
        _wrap(0xA0, _encode_integer(VERSION_1)) + _wrap(0xA1, error),
    )


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    chunks = []
    got = 0
    while got < size:
        piece = sock.recv(size - got)
        if not piece:
            raise ProtocolError("远程桌面在握手时断开了")
        chunks.append(piece)
        got += len(piece)
    return b"".join(chunks)


def _read_tpkt(sock: socket.socket) -> bytes:
    header = _recv_exact(sock, 4)
    if header[0] != 3:
        raise ProtocolError("远程桌面没有返回预期的握手")
    length = int.from_bytes(header[2:4], "big")
    if length < 4 or length > 65535:
        raise ProtocolError("远程桌面握手长度异常")
    return header + _recv_exact(sock, length - 4)


def handshake(x224: bytes) -> tuple[socket.socket, bytes, list[bytes]]:
    """连上本机远程桌面，完成 X.224 和 TLS，返回已经加密的套接字。"""
    raw = socket.create_connection(("127.0.0.1", 3389), timeout=12)
    try:
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        raw.sendall(x224)
        confirm = _read_tpkt(raw)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        secure = context.wrap_socket(raw, server_hostname="127.0.0.1")
    except Exception:
        raw.close()
        raise
    cert = secure.getpeercert(binary_form=True)
    if not cert:
        secure.close()
        raise ProtocolError("没有拿到远程桌面证书")
    secure.settimeout(None)
    return secure, confirm, [cert]


class TlsPump(threading.Thread):
    """单独用一个线程收发 TLS，避免和网页收包抢同一条加密连接。"""

    def __init__(self, sock: socket.socket, on_data, on_close) -> None:
        super().__init__(daemon=True)
        self.sock = sock
        self.on_data = on_data
        self.on_close = on_close
        self._pending = bytearray()
        self._lock = threading.Lock()
        self._closed = threading.Event()

    def send_later(self, data: bytes) -> None:
        with self._lock:
            self._pending.extend(data)

    def close(self) -> None:
        self._closed.set()
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def run(self) -> None:
        sock = self.sock
        try:
            sock.setblocking(False)
        except OSError:
            self.on_close()
            return
        try:
            while not self._closed.is_set():
                with self._lock:
                    has_pending = bool(self._pending)
                readable, writable, _ = select.select(
                    [sock], [sock] if has_pending else [], [], 0.02
                )
                if sock in readable:
                    while True:
                        try:
                            data = sock.recv(65536)
                        except (ssl.SSLWantReadError, BlockingIOError):
                            break
                        except OSError:
                            return
                        if not data:
                            return
                        self.on_data(data)
                if sock in writable:
                    with self._lock:
                        if not self._pending:
                            continue
                        chunk = bytes(self._pending)
                    try:
                        sent = sock.send(chunk)
                    except (ssl.SSLWantWriteError, BlockingIOError):
                        continue
                    except OSError:
                        return
                    with self._lock:
                        del self._pending[:sent]
        finally:
            self.on_close()
