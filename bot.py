"""Bot Telegram tra cứu thông tin & kiểm tra trạng thái LIVE/DIE tài khoản MXH (Facebook, TikTok, Instagram).
Thiết kế giao diện UI/UX cao cấp (Gemini 4 + Codex Aesthetic Edition) với chuẩn thẻ Profile Card HTML và bàn phím tương tác thông minh.
"""

from __future__ import annotations

import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import html
import json
import os
import re
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

# Khống chế thời gian chờ tối đa cho toàn bộ socket, triệt tiêu hoàn toàn nguy cơ treo luồng
socket.setdefaulttimeout(12.0)

HERE = Path(__file__).resolve().parent

# Các trường tra cứu API chính thức
TIKTOK_FIELDS = (
    "display_name,bio_description,avatar_url,is_verified,follower_count,"
    "following_count,likes_count,video_count,bio_url"
)
FACEBOOK_FIELDS = (
    "about", "description", "category", "category_list", "fan_count",
    "followers_count", "link", "website", "phone", "emails", "location",
    "hours", "picture{url}", "username", "is_verified", "checkins",
    "rating_count", "overall_star_rating", "price_range", "is_permanently_closed",
)

# Regex định danh
TIKTOK_HANDLE = re.compile(r"^[A-Za-z0-9._]{2,24}$")
FACEBOOK_ID = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
INSTAGRAM_HANDLE = re.compile(r"^(?!.*\.\.)[A-Za-z0-9._]{1,30}$")

USER_AGENT_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
USER_AGENT_CRAWLER = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
USER_AGENT_TELEGRAM = "TelegramBot (like TwitterBot)"

# Bộ nhớ trạng thái nút bấm cho từng người dùng (Chat State)
USER_STATES: dict[int, str] = {}


def load_dotenv() -> None:
    file = HERE / ".env"
    if not file.exists():
        return
    for line in file.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            os.environ.setdefault(key, value)


class APIError(Exception):
    pass


class ProfileNotFound(APIError):
    pass


class LoginRequired(APIError):
    pass


class RateLimited(APIError):
    def __init__(self, retry_after: str | None = None):
        self.retry_after = retry_after
        msg = f"Instagram giới hạn tần suất yêu cầu (Rate limit). Thử lại sau {retry_after}s" if retry_after else "Instagram giới hạn tần suất yêu cầu. Thử lại sau."
        super().__init__(msg)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def request_json(url: str, *, method: str = "GET", data: dict | None = None,
                 headers: dict | None = None, timeout: int = 15) -> dict:
    payload = None if data is None else json.dumps(data).encode("utf-8")
    request = Request(url, data=payload, method=method,
                      headers={"Accept": "application/json", **(headers or {})})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as exc:
        raise APIError(f"HTTP {exc.code}") from exc
    except (URLError, TimeoutError) as exc:
        raise APIError("Không kết nối được máy chủ") from exc
    except (ValueError, UnicodeError) as exc:
        raise APIError("API trả dữ liệu không hợp lệ") from exc


def resolve_short_link(url: str, timeout: float = 4.0) -> str:
    """Tự động giải mã link rút gọn (vt.tiktok.com, vm.tiktok.com, fb.me, bit.ly, ...) sang URL đích siêu tốc."""
    parsed = urlsplit(url if "://" in url else "https://" + url)
    host = (parsed.hostname or "").lower()
    short_domains = {"vt.tiktok.com", "vm.tiktok.com", "fb.me", "ig.me", "tinyurl.com", "bit.ly"}
    if host in short_domains:
        full_url = url if "://" in url else "https://" + url
        try:
            req = Request(full_url, headers={"User-Agent": USER_AGENT_BROWSER}, method="HEAD")
            with urlopen(req, timeout=timeout) as resp:
                return resp.geturl()
        except Exception:
            try:
                req_get = Request(full_url, headers={"User-Agent": USER_AGENT_BROWSER})
                with urlopen(req_get, timeout=timeout) as resp:
                    return resp.geturl()
            except Exception:
                return url
    return url


def parse_account(text: str) -> tuple[str, str, str]:
    text = text.strip().strip("<>").strip('"').strip("'")
    if not text or len(text) > 800:
        raise ValueError("Vui lòng gửi link hoặc username hợp lệ. Xem /help.")

    words = text.split()
    platform_override = ""
    if len(words) == 2 and words[0].lower() in {"facebook", "fb", "tiktok", "tt", "instagram", "ig"}:
        cmd_prefix = words[0].lower()
        if cmd_prefix in {"facebook", "fb"}:
            platform_override = "facebook"
        elif cmd_prefix in {"tiktok", "tt"}:
            platform_override = "tiktok"
        else:
            platform_override = "instagram"
        text = words[1]

    is_url = bool(re.search(r"^(https?://|[a-zA-Z0-9-]+\.(com|me|am|vn|net|org)/)", text, re.I)) or "://" in text

    if is_url:
        text = resolve_short_link(text)
        url_text = text if "://" in text else "https://" + text
        parsed = urlsplit(url_text)
        try:
            has_port = parsed.port is not None
        except ValueError as exc:
            raise ValueError("Link không hợp lệ.") from exc
        if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or has_port:
            raise ValueError("Link không hợp lệ.")
        host = (parsed.hostname or "").lower()
        clean_host = re.sub(r"^(www\.|m\.|mbasic\.|web\.|touch\.)", "", host)

        # 1. TIKTOK
        if clean_host in {"tiktok.com", "vt.tiktok.com", "vm.tiktok.com"}:
            detected = "tiktok"
            path_parts = [p for p in parsed.path.split("/") if p]
            if not path_parts:
                raise ValueError("Link TikTok không chứa tên tài khoản.")
            first = path_parts[0]
            if first.startswith("@"):
                account = first[1:]
            else:
                if len(path_parts) > 1 and path_parts[1].startswith("@"):
                    account = path_parts[1][1:]
                else:
                    raise ValueError("Link TikTok cần chứa định dạng @username (ví dụ: tiktok.com/@tiktok).")

        # 2. FACEBOOK
        elif clean_host in {"facebook.com", "fb.com", "fb.me"}:
            detected = "facebook"
            query_params = parse_qs(parsed.query)
            if "id" in query_params and query_params["id"][0].isdigit():
                account = query_params["id"][0]
            else:
                path_parts = [p for p in parsed.path.split("/") if p]
                if not path_parts:
                    raise ValueError("Link Facebook không chứa định danh tài khoản.")
                first = path_parts[0].lower()
                if first == "people" and len(path_parts) >= 3 and path_parts[2].isdigit():
                    account = path_parts[2]
                elif first == "pages" and len(path_parts) >= 4 and path_parts[3].isdigit():
                    account = path_parts[3]
                elif first in {"groups", "events", "gaming", "marketplace", "watch", "share", "story.php"}:
                    raise ValueError(f"Link Facebook /{first}/ không phải trang cá nhân hoặc Fanpage.")
                else:
                    account = path_parts[0]

        # 3. INSTAGRAM
        elif clean_host in {"instagram.com", "instagr.am", "ig.me"}:
            detected = "instagram"
            path_parts = [p for p in parsed.path.split("/") if p]
            if not path_parts:
                raise ValueError("Link Instagram không chứa username.")
            first = path_parts[0].lower()
            if first == "_u" and len(path_parts) > 1:
                account = path_parts[1]
            elif first in {"p", "reel", "reels", "stories", "tv", "explore", "direct", "accounts"}:
                raise ValueError(
                    f"Link Instagram /{first}/ không chứa tên tài khoản trong đường dẫn.\n"
                    "👉 Vui lòng gửi link trang cá nhân (ví dụ: instagram.com/username) hoặc gõ: `/check ig username`"
                )
            else:
                account = path_parts[0].lstrip("@")

        else:
            raise ValueError(f"Tên miền '{host}' không được hỗ trợ. Chỉ hỗ trợ Facebook, TikTok và Instagram.")

        if platform_override and platform_override != detected:
            raise ValueError("Nền tảng đã chọn không khớp với đường dẫn URL.")
        platform = detected

    else:
        if not platform_override:
            if text.startswith("@"):
                raise ValueError("Thêm nền tảng cho username: `/check tt @username` hoặc `/check ig @username`.")
            raise ValueError("Vui lòng ghi rõ nền tảng: `/check fb ten_trang`, `/check tt @username`, hoặc `/check ig username`.")
        platform = platform_override
        account = text.lstrip("@")

    account = account.split("?")[0].split("#")[0].strip("/")

    if platform == "tiktok":
        if not TIKTOK_HANDLE.fullmatch(account):
            raise ValueError(f"Username TikTok '{account}' không hợp lệ (từ 2-24 ký tự chữ, số, dấu gạch hoặc chấm).")
        return platform, account, f"https://www.tiktok.com/@{account}"

    if platform == "instagram":
        if not INSTAGRAM_HANDLE.fullmatch(account) or account.startswith(".") or account.endswith("."):
            raise ValueError(f"Username Instagram '{account}' không hợp lệ (1-30 ký tự, không bắt đầu/kết thúc bằng dấu chấm).")
        return platform, account, f"https://www.instagram.com/{account}"

    if not FACEBOOK_ID.fullmatch(account):
        raise ValueError(f"ID/Username Facebook '{account}' không hợp lệ.")
    return platform, account, f"https://www.facebook.com/{account}"


# ==============================================================================
# BÓC TÁCH DỮ LIỆU CÔNG KHAI & HIGH-SPEED CRAWLER CACHE
# ==============================================================================
_HTML_CACHE: dict[str, tuple[float, str]] = {}

def get_cached_page(url: str, ttl: float = 60.0) -> str | None:
    entry = _HTML_CACHE.get(url)
    if entry and (time.time() - entry[0] < ttl):
        return entry[1]
    return None

def set_cached_page(url: str, page: str) -> None:
    if len(_HTML_CACHE) > 500:
        now = time.time()
        for k in [k for k, (t, _) in _HTML_CACHE.items() if now - t > 60.0]:
            _HTML_CACHE.pop(k, None)
    _HTML_CACHE[url] = (time.time(), page)
    # Lưu thêm biến thể không có dấu gạch chéo cuối
    if url.endswith("/"):
        _HTML_CACHE[url[:-1]] = (time.time(), page)
    else:
        _HTML_CACHE[url + "/"] = (time.time(), page)


def lookup_tiktok_public(username: str, timeout: float = 6.0) -> dict | None:
    url = f"https://www.tiktok.com/@{username}"
    page = get_cached_page(url)
    if not page:
        req = Request(url, headers={"User-Agent": USER_AGENT_CRAWLER, "Accept-Language": "en-US,en;q=0.9"})
        try:
            with urlopen(req, timeout=timeout) as resp:
                page = resp.read().decode("utf-8", errors="ignore")
                set_cached_page(url, page)
        except Exception:
            return None

    desc_m = re.search(r'<meta\s+(?:name|property)="(?:\w+:)?description"\s+content="([^"]+)"', page, re.I)
    title_m = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', page, re.I)
    img_m = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', page, re.I)

    info = {}
    if title_m:
        t = html.unescape(title_m.group(1))
        info["display_name"] = re.sub(r"\s+on\s+TikTok$", "", t, flags=re.I).strip()
    if img_m:
        info["avatar_url"] = img_m.group(1)

    if desc_m:
        desc = html.unescape(desc_m.group(1))
        stats = re.search(r'([\d.,KMkm]+)\s+Followers,\s*([\d.,KMkm]+)\s+Following,\s*([\d.,KMkm]+)\s+Likes', desc, re.I)
        if stats:
            info["follower_count"] = stats.group(1).upper()
            info["following_count"] = stats.group(2).upper()
            info["likes_count"] = stats.group(3).upper()
    return info if info else None


def lookup_instagram_public(username: str, timeout: float = 6.0) -> dict | None:
    url = f"https://www.instagram.com/{username}/"
    page = get_cached_page(url)
    if not page:
        req = Request(url, headers={"User-Agent": USER_AGENT_TELEGRAM, "Accept-Language": "en-US,en;q=0.9"})
        try:
            with urlopen(req, timeout=timeout) as resp:
                page = resp.read().decode("utf-8", errors="ignore")
                set_cached_page(url, page)
        except Exception:
            return None

    desc_m = re.search(r'<meta\s+(?:name|property)="(?:\w+:)?description"\s+content="([^"]+)"', page, re.I)
    title_m = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', page, re.I) or re.search(r'<title>(.*?)</title>', page, re.I)
    img_m = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', page, re.I)

    info = {}
    if title_m:
        t = html.unescape(title_m.group(1))
        info["display_name"] = re.sub(r"\s*(?:\(@\w+\))?\s*[•\-]\s*Instagram.*$", "", t, flags=re.I).strip()
    if img_m:
        info["avatar_url"] = img_m.group(1)

    if desc_m:
        desc = html.unescape(desc_m.group(1))
        stats = re.search(r'([\d.,KMkm]+)\s+Followers,\s*([\d.,KMkm]+)\s+Following,\s*([\d.,KMkm]+)\s+Posts', desc, re.I)
        if stats:
            info["follower_count"] = stats.group(1).upper()
            info["following_count"] = stats.group(2).upper()
            info["video_count"] = stats.group(3).upper()
    return info if info else None


# ==============================================================================
# HÀM CHECK LIVE / DIE
# ==============================================================================
def check_live_status(platform: str, identifier: str) -> tuple[str, str]:
    platform = platform.lower().strip()
    name = identifier.strip().lstrip("@")

    domains = {
        "facebook": "www.facebook.com",
        "instagram": "www.instagram.com",
        "tiktok": "www.tiktok.com",
    }
    if platform not in domains:
        return "UNKNOWN", "Nền tảng không hỗ trợ"

    if platform == "instagram":
        api_url = f"https://www.instagram.com/api/v1/users/web_profile_info/?{urlencode({'username': name})}"
        req = Request(api_url, headers={
            "Accept": "application/json",
            "User-Agent": USER_AGENT_BROWSER,
            "X-IG-App-ID": "936619743392459",
            "Referer": "https://www.instagram.com/",
        })
        try:
            with build_opener(_NoRedirect).open(req, timeout=5) as resp:
                data = json.load(resp)
                if data.get("data", {}).get("user"):
                    user = data["data"]["user"]
                    priv = " [Riêng tư 🔒]" if user.get("is_private") else " [Công khai 🌐]"
                    return "LIVE", f"Tài khoản đang hoạt động bình thường{priv}"
        except HTTPError as e:
            if e.code == 404:
                return "DIE", "Không tồn tại tài khoản này (HTTP 404 / Bị xóa hoặc đổi tên)"

    path = f"/@{name}" if platform == "tiktok" else f"/{name}"
    url = f"https://{domains[platform]}{path}/"

    # Kiểm tra nhanh từ cache trước
    cached_html = get_cached_page(url)
    if cached_html:
        page = cached_html
        status = 200
        final_url = url
    else:
        ua = USER_AGENT_CRAWLER if platform == "tiktok" else USER_AGENT_TELEGRAM
        req = Request(url, headers={"User-Agent": ua, "Accept-Language": "en-US,en;q=0.9", "Referer": f"https://{domains[platform]}/"})
        try:
            with urlopen(req, timeout=6) as response:
                status = response.status
                final_url = response.geturl()
                body = response.read(1_000_000)
                charset = response.headers.get_content_charset() or "utf-8"
        except HTTPError as error:
            status = error.code
            final_url = error.geturl()
            body = error.read(1_000_000)
            charset = error.headers.get_content_charset() or "utf-8"
        except (URLError, TimeoutError, OSError) as e:
            return "UNKNOWN", f"Lỗi kết nối: {e}"

        if status in (404, 410):
            return "DIE", f"Không tìm thấy trang hồ sơ (HTTP {status})"

        page = body.decode(charset, errors="replace")
        set_cached_page(url, page)
        set_cached_page(final_url, page)
    final = urlsplit(final_url)

    if re.search(r"/(login|accounts/login|challenge|checkpoint)(/|$)", final.path, re.I):
        return "UNKNOWN", "Bị chuyển hướng yêu cầu đăng nhập"

    visible = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", page, flags=re.I | re.S)
    visible = html.unescape(re.sub(r"<[^>]+>", " ", visible))
    visible_clean = re.sub(r"\s+", " ", visible).lower()

    missing_patterns = {
        "facebook": (
            r"\btrang này không khả dụng\b",
            r"\bthis content isn't available\b",
            r"\bthis page isn't available\b",
            r"\bprofile not found\b",
            r"\bliên kết bạn đã theo dõi có thể bị hỏng\b",
        ),
        "instagram": (
            r"\brất tiếc, trang này hiện không khả dụng\b",
            r"\bsorry, this page isn't available\b",
            r"\bthe link you followed may be broken\b",
        ),
        "tiktok": (
            r"\bcouldn't find this account\b",
            r"\baccount not found\b",
            r"\bkhông tìm thấy tài khoản này\b",
        ),
    }

    if any(re.search(pat, visible_clean) for pat in missing_patterns.get(platform, ())):
        return "DIE", "Nền tảng thông báo nội dung/tài khoản không khả dụng"

    if status != 200:
        return "UNKNOWN", f"Trạng thái HTTP {status}"

    name_escaped = re.escape(name)
    if platform == "tiktok":
        if (re.search(r'Followers', page, re.I) or re.search(r'"uniqueId"\s*:\s*"' + name_escaped + r'"', page, re.I) or f"@{name.lower()}" in page.lower()):
            return "LIVE", "Hồ sơ TikTok đang hoạt động công khai"
    elif platform == "instagram":
        if (re.search(r'Followers', page, re.I) or re.search(r'"username"\s*:\s*"' + name_escaped + r'"', page, re.I)):
            return "LIVE", "Hồ sơ Instagram đang hoạt động"
    elif platform == "facebook":
        if (re.search(r'<meta\b[^>]*property=["\']og:type["\'][^>]*content=["\'](profile|website)["\']', page, re.I) or "facebook.com" in page):
            return "LIVE", "Trang/Hồ sơ Facebook đang hoạt động"

    return "UNKNOWN", "Không đủ tín hiệu xác định"


# ==============================================================================
# API CHÍNH THỨC
# ==============================================================================
class TikTokResearch:
    def __init__(self, key: str, secret: str):
        self.key = key
        self.secret = secret
        self.token = ""
        self.expires_at = 0.0

    def access_token(self) -> str:
        if self.token and time.monotonic() < self.expires_at:
            return self.token
        body = urlencode({"client_key": self.key, "client_secret": self.secret,
                          "grant_type": "client_credentials"}).encode("utf-8")
        req = Request("https://open.tiktokapis.com/v2/oauth/token/", data=body,
                      headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with urlopen(req, timeout=15) as response:
                result = json.load(response)
        except Exception as exc:
            raise APIError("Không lấy được TikTok token") from exc
        token = result.get("access_token")
        if not token:
            raise APIError("TikTok từ chối cấp token")
        self.token = token
        self.expires_at = time.monotonic() + max(0, int(result.get("expires_in", 0)) - 60)
        return token

    def lookup(self, username: str) -> dict:
        url = "https://open.tiktokapis.com/v2/research/user/info/?" + urlencode({"fields": TIKTOK_FIELDS})
        try:
            result = request_json(url, method="POST", data={"username": username},
                                  headers={"Content-Type": "application/json",
                                           "Authorization": "Bearer " + self.access_token()})
        except Exception as exc:
            raise APIError(f"Lỗi kết nối Research API: {exc}")
        info = result.get("data")
        if not isinstance(info, dict) or not info:
            raise APIError("TikTok không trả dữ liệu")
        return info


def lookup_facebook(identifier: str, token: str, version: str) -> dict:
    if not re.fullmatch(r"v\d+\.\d+", version):
        raise APIError("META_GRAPH_VERSION không hợp lệ")

    url = (f"https://graph.facebook.com/{version}/{quote(identifier, safe='')}?" +
           urlencode({"fields": "id,name," + ",".join(FACEBOOK_FIELDS[:8])}))
    return request_json(url, headers={"Authorization": "Bearer " + token})


def lookup_instagram_web(username: str, session_id: str | None = None, timeout: float = 10.0) -> dict:
    url = f"https://www.instagram.com/api/v1/users/web_profile_info/?{urlencode({'username': username})}"
    headers = {
        "Accept": "application/json",
        "User-Agent": USER_AGENT_BROWSER,
        "X-IG-App-ID": "936619743392459",
        "Referer": "https://www.instagram.com/",
    }
    if session_id:
        headers["Cookie"] = f"sessionid={session_id}"

    req = Request(url, headers=headers)
    with build_opener(_NoRedirect).open(req, timeout=timeout) as resp:
        payload = json.load(resp)
    user = (payload.get("data") or {}).get("user")
    if not isinstance(user, dict):
        raise ProfileNotFound("Không tìm thấy profile")

    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "full_name": user.get("full_name"),
        "biography": user.get("biography"),
        "follower_count": (user.get("edge_followed_by") or {}).get("count"),
        "following_count": (user.get("edge_follow") or {}).get("count"),
        "video_count": (user.get("edge_owner_to_timeline_media") or {}).get("count"),
        "is_private": user.get("is_private"),
        "is_verified": user.get("is_verified"),
        "avatar_url": user.get("profile_pic_url_hd") or user.get("profile_pic_url"),
        "website": user.get("external_url"),
    }


# ==============================================================================
# HỆ THỐNG GIAO DIỆN & PROFILE CARD (GEMINI 4 + CODEX DESIGN SYSTEM)
# ==============================================================================
class ResultTuple(tuple):
    """Bộ trả về tương thích ngược 2 phần tử (text, reply_markup) tích hợp thêm avatar_url."""
    def __new__(cls, text: str, reply_markup: dict | None = None, avatar_url: str | None = None):
        return super().__new__(cls, (text, reply_markup))

    def __init__(self, text: str, reply_markup: dict | None = None, avatar_url: str | None = None):
        self.text = text
        self.reply_markup = reply_markup
        self.avatar_url = avatar_url


MAIN_REPLY_KEYBOARD = {
    "keyboard": [
        [{"text": "⚡ Check Live/Die Nhanh"}, {"text": "📋 Quét Hàng Loạt"}],
        [{"text": "📸 Instagram"}, {"text": "🎵 TikTok"}, {"text": "📘 Facebook"}],
        [{"text": "❓ Hướng Dẫn & Trợ Giúp"}]
    ],
    "resize_keyboard": True,
    "is_persistent": True
}


def make_inline_result_keyboard(url: str, identifier: str) -> dict:
    return {
        "inline_keyboard": [
            [
                {"text": "🌐 Mở Profile Gốc", "url": url},
                {"text": "🔄 Quét Lại", "callback_data": f"recheck:{url}"}
            ],
            [
                {"text": "⚡ Check Acc Khác", "callback_data": "cmd:live"},
                {"text": "📋 Quét Hàng Loạt", "callback_data": "cmd:batch"}
            ]
        ]
    }


def format_live_badge(status: str) -> str:
    if status == "LIVE":
        return "🟢 <b>LIVE</b> <i>(Đang hoạt động)</i>"
    if status == "DIE":
        return "🔴 <b>DIE</b> <i>(Bị khóa / Không tìm thấy / 404)</i>"
    return "🟡 <b>CHƯA RÕ</b> <i>(Bị rào cản đăng nhập / Cần token)</i>"


def format_number(val: object) -> str:
    if isinstance(val, (int, float)):
        val_int = int(val)
        exact = f"{val_int:,}"
        if val_int >= 1_000_000_000:
            return f"{exact} ({val_int / 1_000_000_000:.1f}B)"
        if val_int >= 1_000_000:
            return f"{exact} ({val_int / 1_000_000:.1f}M)"
        if val_int >= 10_000:
            return f"{exact} ({val_int / 1_000:.1f}K)"
        return exact
    if isinstance(val, str):
        return val
    return str(val) if val is not None else ""


def render_profile_card(platform: str, identifier: str, url: str, info: dict,
                        live_status: str = "LIVE", reason: str = "",
                        elapsed: float | None = None) -> str:
    """Thiết kế thẻ Profile Card cao cấp (Gemini 4 + Codex Aesthetic Edition) chuẩn Telegram HTML."""
    platform_meta = {
        "instagram": ("📸 INSTAGRAM PROFILE", "🟣", "Instagram"),
        "tiktok": ("🎵 TIKTOK PROFILE", "⚫", "TikTok"),
        "facebook": ("📘 FACEBOOK PROFILE", "🔵", "Facebook"),
    }
    header_title, dot_icon, p_name = platform_meta.get(
        platform, (f"{platform.upper()} PROFILE", "⚪", platform.capitalize())
    )
    safe_id = html.escape(identifier)
    safe_url = html.escape(url)

    display_name = info.get("display_name") or info.get("full_name") or info.get("name") or safe_id
    safe_name = html.escape(str(display_name))
    badge = format_live_badge(live_status)

    # Thước đo tín hiệu mạng & trạng thái sống động
    if live_status == "LIVE":
        signal_bar = "<code>[████████████████████] 100% ONLINE</code>"
    elif live_status == "DIE":
        signal_bar = "<code>[░░░░░░░░░░░░░░░░░░░░] OFFLINE / KHÓA</code>"
    else:
        signal_bar = "<code>[██████████░░░░░░░░░░] YÊU CẦU ĐĂNG NHẬP</code>"

    lines = [
        f"<b>{dot_icon} ━━━━━━━━ {header_title} ━━━━━━━━</b>",
        "",
        f"👤 <b>Tên hiển thị:</b> <b>{safe_name}</b>",
        f"🏷️ <b>Username:</b> <code>@{safe_id}</code>",
        f"⚡ <b>Trạng thái:</b> {badge}",
        f"📶 <b>Tín hiệu máy chủ:</b> {signal_bar}",
    ]

    if reason:
        lines.append(f"ℹ️ <b>Ghi chú:</b> <i>{html.escape(reason)}</i>")

    # Metrics
    stat_rows = []
    if "follower_count" in info and info["follower_count"] is not None:
        stat_rows.append(f"• 👥 <b>Followers:</b> <code>{format_number(info['follower_count'])}</code>")
    if "following_count" in info and info["following_count"] is not None:
        stat_rows.append(f"• 👣 <b>Following:</b> <code>{format_number(info['following_count'])}</code>")
    if "likes_count" in info and info["likes_count"] is not None:
        stat_rows.append(f"• ❤️ <b>Lượt thích:</b> <code>{format_number(info['likes_count'])}</code>")
    if "video_count" in info and info["video_count"] is not None:
        stat_rows.append(f"• 🎬 <b>Bài viết / Video:</b> <code>{format_number(info['video_count'])}</code>")
    if "fan_count" in info and info["fan_count"] is not None:
        stat_rows.append(f"• 👍 <b>Lượt thích Trang:</b> <code>{format_number(info['fan_count'])}</code>")
    if "is_verified" in info and info["is_verified"] is not None:
        ver_text = "Có ✅ (Tích xanh chính chủ)" if info["is_verified"] else "Không ❌"
        stat_rows.append(f"• 🛡️ <b>Tích xanh:</b> {ver_text}")
    if "is_private" in info and info["is_private"] is not None:
        priv_text = "Riêng tư 🔒" if info["is_private"] else "Công khai 🌐"
        stat_rows.append(f"• 🔐 <b>Quyền riêng tư:</b> {priv_text}")

    if stat_rows:
        lines.append("")
        lines.append("📊 <b>CHỈ SỐ TƯƠNG TÁC THỜI GIAN THỰC</b>")
        lines.extend(stat_rows)

    bio = info.get("biography") or info.get("bio_description") or info.get("about")
    if bio:
        safe_bio = html.escape(str(bio).strip())
        if safe_bio:
            lines.append("")
            lines.append(f"<blockquote>📝 <b>Tiểu sử (Bio):</b>\n{safe_bio[:280]}</blockquote>")

    lines.append("")
    lines.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    if elapsed is not None:
        lines.append(f"⚡ <i>Tốc độ phản hồi: <b>{elapsed:.2f}s</b> • Realtime Engine</i>")
    lines.append(f"🔗 <a href=\"{safe_url}\">Mở trang cá nhân gốc trên {p_name} ➔</a>")

    return "\n".join(lines)


WELCOME_HTML = (
    "✨ <b>HỆ THỐNG CHECK LIVE/DIE & THÔNG SỐ MXH PRO</b> ✨\n"
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    "<i>Giải pháp tự động nhận diện Live/Die và trích xuất chỉ số tương tác thời gian thực.</i>\n\n"
    "🎯 <b>NỀN TẢNG HỖ TRỢ:</b>\n"
    "• 📸 <b>Instagram:</b> Followers, Following, Posts, Tích xanh, Bio, Avatar HD.\n"
    "• 🎵 <b>TikTok:</b> Followers, Likes, Following, Link video, Link app (<code>vt.tiktok.com</code>).\n"
    "• 📘 <b>Facebook:</b> Fanpage, Profile cá nhân, ID số, Bài viết công khai.\n\n"
    "⚡ <b>CÁCH SỬ DỤNG SIÊU TIỆN:</b>\n"
    "1. <b>Bấm các nút phía dưới màn hình</b> để chọn nền tảng bạn muốn kiểm tra.\n"
    "2. <b>Dán link hoặc gõ username</b> gửi vào chat là bot phân tích ngay!\n"
    "3. <b>Quét hàng loạt:</b> Dán danh sách nhiều tài khoản cùng lúc để nhận bảng tổng kết.\n"
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
)


def render_batch_card(lines: list[str]) -> str:
    valid_items = [(idx, line.strip()) for idx, line in enumerate(lines[:30], start=1) if line.strip()]
    if not valid_items:
        return "⚠️ Không tìm thấy dòng dữ liệu nào hợp lệ để quét."

    t0 = time.perf_counter()

    def check_worker(item):
        idx, raw_line = item
        try:
            platform, identifier, url = parse_account(raw_line)
            st, reason = check_live_status(platform, identifier)
            return (idx, platform, identifier, st, reason, None)
        except Exception as e:
            return (idx, None, raw_line, "ERROR", "", str(e))

    # Tối ưu hóa: Quét song song bằng ThreadPoolExecutor với tối đa 12 workers
    with ThreadPoolExecutor(max_workers=min(12, len(valid_items))) as pool:
        processed_items = list(pool.map(check_worker, valid_items))

    results = []
    live_cnt = 0
    die_cnt = 0
    unknown_cnt = 0

    for idx, platform, identifier, st, reason, err in processed_items:
        if err:
            results.append(f"<b>{idx}.</b> <code>{html.escape(identifier[:30])}</code> ➔ ⚠️ <i>{html.escape(err)}</i>")
            continue

        p_icon = "🎵" if platform == "tiktok" else ("📸" if platform == "instagram" else "📘")
        if st == "LIVE":
            live_cnt += 1
            status_badge = "🟢 <b>LIVE</b>"
        elif st == "DIE":
            die_cnt += 1
            status_badge = "🔴 <b>DIE</b>"
        else:
            unknown_cnt += 1
            status_badge = "🟡 <b>CHƯA RÕ</b>"
        results.append(f"<b>{idx}.</b> {p_icon} <code>@{html.escape(identifier)}</code> ➔ {status_badge}")

    elapsed = time.perf_counter() - t0
    total = live_cnt + die_cnt + unknown_cnt
    output = [
        "📊 <b>BÁO CÁO QUÉT LIVE / DIE HÀNG LOẠT</b>",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        f"📈 <b>Tổng số đã quét:</b> <code>{total}</code> tài khoản (⚡ <i>Xong trong {elapsed:.2f}s</i>)",
        f"• 🟢 <b>Tài khoản LIVE:</b> <code>{live_cnt}</code>",
        f"• 🔴 <b>Tài khoản DIE:</b> <code>{die_cnt}</code>",
        f"• 🟡 <b>Chưa rõ:</b> <code>{unknown_cnt}</code>",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        *results,
        "",
        "<i>💡 Bạn có thể gửi từng link riêng lẻ để nhận ảnh đại diện và chi tiết số đo đầy đủ.</i>"
    ]
    return "\n".join(output)


def handle(text: str, tiktok: TikTokResearch | None, meta_token: str, meta_version: str,
           ig_session: str | None = None, ig_business_id: str | None = None,
           chat_id: int | None = None, start_time: float | None = None) -> tuple[str, dict | None]:
    text = text.strip()
    elapsed = (time.perf_counter() - start_time) if start_time else None

    if text.startswith(("/start", "/help")) or text == "❓ Hướng Dẫn & Trợ Giúp":
        if chat_id:
            USER_STATES.pop(chat_id, None)
        return WELCOME_HTML, None

    # Xử lý các nút bấm Reply Keyboard
    if text in {"⚡ Check Live/Die Nhanh", "⚡ Check Live/Die"}:
        if chat_id:
            USER_STATES[chat_id] = "live"
        return (
            "⚡ <b>CHẾ ĐỘ KIỂM TRA NHANH LIVE / DIE</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "👉 <b>Hãy dán link hoặc username bất kỳ</b> của TikTok, FB, hoặc Instagram vào đây để quét trạng thái sống/chết nhé:"
        ), None

    if text in {"📸 Instagram", "📸 Check Instagram"}:
        if chat_id:
            USER_STATES[chat_id] = "ig"
        return (
            "📸 <b>CHẾ ĐỘ KIỂM TRA INSTAGRAM</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "👉 <b>Hãy dán link hoặc gõ username Instagram</b> bạn muốn kiểm tra vào đây:\n"
            "<i>(Ví dụ: <code>cristiano</code> hoặc <code>instagram.com/cristiano</code>)</i>"
        ), None

    if text in {"🎵 TikTok", "🎵 Check TikTok"}:
        if chat_id:
            USER_STATES[chat_id] = "tt"
        return (
            "🎵 <b>CHẾ ĐỘ KIỂM TRA TIKTOK</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "👉 <b>Hãy dán link TikTok</b> (hỗ trợ cả link video, link app <code>vt.tiktok.com</code>) hoặc gõ <code>@username</code> vào đây:"
        ), None

    if text in {"📘 Facebook", "📘 Check Facebook"}:
        if chat_id:
            USER_STATES[chat_id] = "fb"
        return (
            "📘 <b>CHẾ ĐỘ KIỂM TRA FACEBOOK</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "👉 <b>Hãy dán link Fanpage, Profile cá nhân hoặc ID Facebook</b> vào đây:"
        ), None

    if text in {"📋 Quét Hàng Loạt", "📋 Check Hàng Loạt"}:
        if chat_id:
            USER_STATES[chat_id] = "batch"
        return (
            "📋 <b>CHẾ ĐỘ QUÉT HÀNG LOẠT NHIỀU TÀI KHOẢN</b>\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "👉 <b>Hãy dán danh sách tài khoản vào đây</b> <i>(mỗi dòng một link hoặc username)</i>, bot sẽ tự động quét và trả về báo cáo tổng kết:"
        ), None

    # Nếu người dùng đang trong trạng thái chờ nhập của một nút bấm
    user_state = USER_STATES.pop(chat_id, None) if chat_id else None
    if user_state and not text.startswith("/"):
        if user_state == "live":
            text = "/live " + text
        elif user_state in {"ig", "tt", "fb"} and not any(text.lower().startswith(x) for x in ["http://", "https://", "ig ", "tt ", "fb "]):
            text = f"{user_state} {text}"

    # Kiểm tra gửi danh sách nhiều dòng
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) > 1 and not text.startswith("/"):
        return render_batch_card(lines), None

    # Lệnh /live nhanh
    if text.startswith("/live"):
        target = text[5:].strip()
        if not target:
            return ResultTuple("⚠️ Vui lòng cung cấp link hoặc username sau lệnh /live. Ví dụ: <code>/live ig cristiano</code>", None)
        try:
            platform, identifier, url = parse_account(target)
            st, reason = check_live_status(platform, identifier)
            inline_kb = make_inline_result_keyboard(url, identifier)
            info = {}
            if st == "LIVE":
                if platform == "tiktok":
                    pub = lookup_tiktok_public(identifier)
                    if pub:
                        info.update(pub)
                elif platform == "instagram":
                    pub = lookup_instagram_public(identifier)
                    if pub:
                        info.update(pub)

            elapsed = (time.perf_counter() - start_time) if start_time else None
            card_html = render_profile_card(platform, identifier, url, info, live_status=st, reason=reason, elapsed=elapsed)
            avatar = info.get("avatar_url")
            return ResultTuple(card_html, inline_kb, avatar_url=avatar)
        except ValueError as exc:
            return ResultTuple(f"⚠️ <b>Lỗi:</b> {html.escape(str(exc))}\n\n{WELCOME_HTML}", None)

    # Lệnh /check hoặc dán link đơn
    command = re.match(r"^/(check|facebook|fb|tiktok|tt|instagram|ig)(?:@\w+)?(?:\s+|$)", text, re.I)
    if command:
        arg = text[command.end():].strip()
        name = command.group(1).lower()
        if name in {"fb", "facebook"}:
            arg = "fb " + arg
        elif name in {"tt", "tiktok"}:
            arg = "tt " + arg
        elif name in {"ig", "instagram"}:
            arg = "ig " + arg
        text = arg

    try:
        platform, identifier, url = parse_account(text)
    except ValueError as exc:
        return ResultTuple(f"⚠️ <b>Lỗi:</b> {html.escape(str(exc))}\n\n{WELCOME_HTML}", None)

    live_status, reason = check_live_status(platform, identifier)
    inline_kb = make_inline_result_keyboard(url, identifier)

    # 1. TIKTOK
    if platform == "tiktok":
        info = {}
        pub_info = lookup_tiktok_public(identifier)
        if pub_info:
            info.update(pub_info)

        if tiktok and live_status != "DIE":
            try:
                api_info = tiktok.lookup(identifier)
                info.update(api_info)
            except Exception:
                pass

        elapsed = (time.perf_counter() - start_time) if start_time else None
        card = render_profile_card(platform, identifier, url, info, live_status=live_status, reason=reason or "Hồ sơ TikTok", elapsed=elapsed)
        avatar = info.get("avatar_url")
        return ResultTuple(card, inline_kb, avatar_url=avatar)

    # 2. INSTAGRAM
    elif platform == "instagram":
        elapsed = (time.perf_counter() - start_time) if start_time else None
        if live_status == "DIE":
            card = render_profile_card(platform, identifier, url, {}, live_status="DIE", reason=reason or "Tài khoản không tồn tại hoặc đã bị khóa/xóa.", elapsed=elapsed)
            return ResultTuple(card, inline_kb, avatar_url=None)

        info = {}
        pub_info = lookup_instagram_public(identifier)
        if pub_info:
            info.update(pub_info)

        try:
            web_info = lookup_instagram_web(identifier, session_id=ig_session)
            info.update(web_info)
        except Exception:
            pass

        card = render_profile_card(platform, identifier, url, info, live_status="LIVE", reason=reason or "Hồ sơ Instagram đang hoạt động", elapsed=elapsed)
        avatar = info.get("avatar_url")
        return ResultTuple(card, inline_kb, avatar_url=avatar)

    # 3. FACEBOOK
    elif platform == "facebook":
        info = {}
        if meta_token and live_status != "DIE":
            try:
                info = lookup_facebook(identifier, meta_token, meta_version)
            except Exception:
                pass
        elapsed = (time.perf_counter() - start_time) if start_time else None
        card = render_profile_card(platform, identifier, url, info, live_status=live_status, reason=reason or "Trang/Hồ sơ Facebook", elapsed=elapsed)
        avatar = info.get("avatar_url") or ((info.get("picture") or {}).get("data") or {}).get("url")
        return ResultTuple(card, inline_kb, avatar_url=avatar)

    elapsed = (time.perf_counter() - start_time) if start_time else None
    card = render_profile_card(platform, identifier, url, {}, live_status=live_status, reason=reason, elapsed=elapsed)
    return ResultTuple(card, inline_kb, avatar_url=None)


def telegram_call(token: str, method: str, payload: dict, timeout: int = 15) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    result = request_json(url, method="POST", data=payload,
                          headers={"Content-Type": "application/json"}, timeout=timeout)
    if not result.get("ok"):
        raise APIError("Telegram Bot API từ chối yêu cầu")
    return result


def send_telegram_result(token: str, chat_id: int, result: tuple, reply_markup: dict | None,
                         reply_to_message_id: int | None = None, prefix: str = "") -> None:
    """Gửi kết quả kèm ảnh Avatar Card cao cấp hoặc fallback sang tin nhắn HTML sang trọng."""
    text = result[0]
    full_text = f"{prefix}\n\n{text}" if prefix else text
    avatar_url = getattr(result, "avatar_url", None)

    # Thử gửi ảnh đại diện làm thẻ Profile Photo
    if avatar_url and isinstance(avatar_url, str) and avatar_url.startswith("http"):
        caption = full_text if len(full_text) <= 1020 else full_text[:1000] + "\n..."
        photo_payload = {
            "chat_id": chat_id,
            "photo": avatar_url,
            "caption": caption,
            "parse_mode": "HTML",
            "reply_markup": reply_markup
        }
        if reply_to_message_id:
            photo_payload["reply_parameters"] = {"message_id": reply_to_message_id}
        try:
            telegram_call(token, "sendPhoto", photo_payload, timeout=12)
            return
        except Exception:
            # Fallback sang gửi tin nhắn văn bản nếu ảnh lỗi hoặc quá thời gian tải
            pass

    # Gửi tin nhắn HTML văn bản
    msg_payload = {
        "chat_id": chat_id,
        "text": full_text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "reply_markup": reply_markup
    }
    if reply_to_message_id:
        msg_payload["reply_parameters"] = {"message_id": reply_to_message_id}

    try:
        telegram_call(token, "sendMessage", msg_payload, timeout=12)
    except Exception:
        # Fallback an toàn nếu có thẻ HTML lỗi cú pháp
        msg_payload["text"] = re.sub(r"<[^>]+>", "", full_text)
        msg_payload.pop("parse_mode", None)
        try:
            telegram_call(token, "sendMessage", msg_payload, timeout=12)
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] ⚠️ Không gửi được tin nhắn tới {chat_id}: {e}", file=sys.stderr, flush=True)


def process_message_job(token: str, message: dict, tiktok, meta_token: str, meta_version: str,
                        ig_session: str | None, ig_biz_id: str | None, allowed: set[str]) -> None:
    """Xử lý tin nhắn trong luồng riêng biệt (worker thread) để không làm nghẽn polling loop."""
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    body = message.get("text")
    msg_id = message.get("message_id")
    if not chat_id or not isinstance(body, str):
        return
    if allowed and str(chat_id) not in allowed:
        return
    if chat.get("type") != "private" and not body.startswith("/"):
        return

    now_str = time.strftime("%H:%M:%S")
    print(f"[{now_str}] 📩 Nhận tin nhắn từ ChatID {chat_id}: {body[:70]!r}", flush=True)

    # ⚡ PHẢN HỒI TỨC THÌ (<0.1s): Bật trạng thái 'đang gõ' ngay lập tức
    try:
        telegram_call(token, "sendChatAction", {"chat_id": chat_id, "action": "typing"}, timeout=3)
    except Exception:
        pass

    t0 = time.perf_counter()
    try:
        res = handle(
            body, tiktok, meta_token, meta_version,
            ig_session=ig_session, ig_business_id=ig_biz_id,
            chat_id=chat_id,
            start_time=t0
        )
        reply_markup = res[1] if res[1] else MAIN_REPLY_KEYBOARD
        send_telegram_result(token, chat_id, res, reply_markup, reply_to_message_id=msg_id)
        elapsed = time.perf_counter() - t0
        print(f"[{time.strftime('%H:%M:%S')}] 📤 Đã phản hồi tới ChatID {chat_id} (chỉ {elapsed:.2f}s) ⚡", flush=True)
    except Exception as handle_err:
        print(f"[{time.strftime('%H:%M:%S')}] ⚠️ Lỗi xử lý {chat_id}: {handle_err}", file=sys.stderr, flush=True)
        try:
            telegram_call(token, "sendMessage", {
                "chat_id": chat_id,
                "text": f"⚠️ Đã có lỗi xảy ra: {html.escape(str(handle_err))}",
                "parse_mode": "HTML",
                "reply_parameters": {"message_id": msg_id},
                "reply_markup": MAIN_REPLY_KEYBOARD
            }, timeout=10)
        except Exception:
            pass


def process_callback_job(token: str, cb: dict, tiktok, meta_token: str, meta_version: str,
                         ig_session: str | None, ig_biz_id: str | None) -> None:
    """Xử lý callback query từ inline buttons trong luồng riêng biệt."""
    cb_id = cb["id"]
    cb_data = cb.get("data", "")
    cb_chat = (cb.get("message") or {}).get("chat", {})
    cb_chat_id = cb_chat.get("id")

    toast_msg = "⚡ Đang xử lý siêu tốc..."
    if cb_data.startswith("recheck:"):
        toast_msg = "🔄 Đang quét lại dữ liệu mới nhất..."

    try:
        telegram_call(token, "answerCallbackQuery", {"callback_query_id": cb_id, "text": toast_msg}, timeout=3)
    except Exception:
        pass

    if not cb_chat_id:
        return

    print(f"[{time.strftime('%H:%M:%S')}] 🔘 Nhận tương tác nút bấm từ ChatID {cb_chat_id}: {cb_data}", flush=True)

    if cb_data == "cmd:live":
        USER_STATES[cb_chat_id] = "live"
        telegram_call(token, "sendMessage", {
            "chat_id": cb_chat_id,
            "text": "⚡ <b>Chế độ Check Nhanh Live/Die:</b>\n👉 Hãy dán link hoặc username vào đây:",
            "parse_mode": "HTML",
            "reply_markup": MAIN_REPLY_KEYBOARD
        }, timeout=10)
    elif cb_data == "cmd:batch":
        USER_STATES[cb_chat_id] = "batch"
        telegram_call(token, "sendMessage", {
            "chat_id": cb_chat_id,
            "text": "📋 <b>Chế độ Quét Hàng Loạt:</b>\n👉 Hãy dán danh sách nhiều tài khoản vào đây:",
            "parse_mode": "HTML",
            "reply_markup": MAIN_REPLY_KEYBOARD
        }, timeout=10)
    elif cb_data.startswith("recheck:"):
        recheck_url = cb_data[8:]
        # Xóa cache để ép buộc quét mới
        _HTML_CACHE.pop(recheck_url, None)
        _HTML_CACHE.pop(recheck_url.rstrip("/"), None)
        _HTML_CACHE.pop(recheck_url + "/", None)

        try:
            telegram_call(token, "sendChatAction", {"chat_id": cb_chat_id, "action": "typing"}, timeout=3)
        except Exception:
            pass

        t0 = time.perf_counter()
        res = handle(recheck_url, tiktok, meta_token, meta_version,
                     ig_session=ig_session, ig_business_id=ig_biz_id,
                     chat_id=cb_chat_id, start_time=t0)
        recheck_markup = res[1] or MAIN_REPLY_KEYBOARD
        send_telegram_result(token, cb_chat_id, res, recheck_markup,
                             prefix="🔄 <b>KẾT QUẢ QUÉT LẠI MỚI NHẤT:</b>")


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Bot Telegram Check Live MXH is running 24/7!")

    def log_message(self, format, *args):
        pass


def main() -> int:
    load_dotenv()
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token or token == "YOUR_TELEGRAM_BOT_TOKEN":
        print("❌ Thiếu TELEGRAM_BOT_TOKEN trong file .env hoặc biến môi trường.", file=sys.stderr)
        return 2

    # Khởi chạy HTTP health-check server cho Render / Cloud nếu có PORT
    port_env = os.getenv("PORT")
    if port_env:
        try:
            port = int(port_env)
            server = HTTPServer(("0.0.0.0", port), HealthHandler)
            t = threading.Thread(target=server.serve_forever, daemon=True)
            t.start()
            print(f"🌐 HTTP Health-check server listening on port {port}", flush=True)
        except Exception as e:
            print(f"⚠️ Không thể khởi động HTTP health check: {e}", flush=True)

    key = os.getenv("TIKTOK_CLIENT_KEY", "").strip()
    secret = os.getenv("TIKTOK_CLIENT_SECRET", "").strip()
    tiktok = TikTokResearch(key, secret) if key and secret else None

    meta_token = os.getenv("META_ACCESS_TOKEN", "").strip()
    meta_version = os.getenv("META_GRAPH_VERSION", "v24.0").strip()

    ig_session = os.getenv("INSTAGRAM_SESSION_ID", "").strip() or None
    ig_biz_id = os.getenv("INSTAGRAM_BUSINESS_ACCOUNT_ID", "").strip() or None

    allowed = {x.strip() for x in os.getenv("ALLOWED_CHAT_IDS", "").split(",") if x.strip()}

    executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="BotWorker")
    offset = None

    print("=" * 65, flush=True)
    print("🚀 BOT TELEGRAM CHECK LIVE/DIE & THÔNG TIN MXH (FB - TIKTOK - INSTAGRAM)", flush=True)
    print("✨ Kiến trúc Multi-thread & Giao diện Profile Card Rich Media", flush=True)
    print(f"✅ Bot khởi động lúc {time.strftime('%Y-%m-%d %H:%M:%S')} (Nhấn Ctrl+C để dừng)", flush=True)
    print("=" * 65, flush=True)

    consecutive_errors = 0

    while True:
        try:
            # Polling 2s với timeout 10s: cực nhanh, phản hồi tức thì, không bị drop kết nối
            poll_payload = {"timeout": 2, "allowed_updates": ["message", "callback_query"]}
            if offset is not None:
                poll_payload["offset"] = offset

            updates_resp = telegram_call(token, "getUpdates", poll_payload, timeout=10)
            updates = updates_resp.get("result", [])
            consecutive_errors = 0

            for update in updates:
                offset = update["update_id"] + 1

                # 1. Callback Query
                if "callback_query" in update:
                    executor.submit(
                        process_callback_job, token, update["callback_query"],
                        tiktok, meta_token, meta_version, ig_session, ig_biz_id
                    )

                # 2. Regular Message
                elif "message" in update:
                    executor.submit(
                        process_message_job, token, update["message"],
                        tiktok, meta_token, meta_version, ig_session, ig_biz_id, allowed
                    )

        except KeyboardInterrupt:
            print("\n🛑 Đang tắt bot an toàn...", flush=True)
            executor.shutdown(wait=False)
            return 0
        except Exception as exc:
            err_msg = str(exc)
            # Socket timeout là trạng thái bình thường khi polling không có tin nhắn mới
            if "timed out" in err_msg.lower() or "timeout" in err_msg.lower():
                time.sleep(0.3)
                continue

            consecutive_errors += 1
            delay = min(5, consecutive_errors)
            print(f"[{time.strftime('%H:%M:%S')}] ⚠️ Ngoại lệ polling: {exc}. Tự động thử lại sau {delay}s...", file=sys.stderr, flush=True)
            time.sleep(delay)


if __name__ == "__main__":
    raise SystemExit(main())
