import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bot


class BotTests(unittest.TestCase):
    def test_parse_supported_profiles(self):
        # TikTok standard & variations
        self.assertEqual(
            bot.parse_account("tt @tester"),
            ("tiktok", "tester", "https://www.tiktok.com/@tester"),
        )
        self.assertEqual(
            bot.parse_account("https://www.tiktok.com/@my_profile"),
            ("tiktok", "my_profile", "https://www.tiktok.com/@my_profile"),
        )
        self.assertEqual(
            bot.parse_account("tiktok.com/@user_video/video/7345678901234567890?_t=8l..."),
            ("tiktok", "user_video", "https://www.tiktok.com/@user_video"),
        )
        self.assertEqual(
            bot.parse_account("https://m.tiktok.com/@streamer/live"),
            ("tiktok", "streamer", "https://www.tiktok.com/@streamer"),
        )

        # Facebook standard & variations
        self.assertEqual(
            bot.parse_account("https://www.facebook.com/profile.php?id=12345&mibextid=abc"),
            ("facebook", "12345", "https://www.facebook.com/12345"),
        )
        self.assertEqual(
            bot.parse_account("fb.com/my_page"),
            ("facebook", "my_page", "https://www.facebook.com/my_page"),
        )
        self.assertEqual(
            bot.parse_account("https://www.facebook.com/user_post/posts/pfbid0abc123"),
            ("facebook", "user_post", "https://www.facebook.com/user_post"),
        )

        # Instagram standard & variations
        self.assertEqual(
            bot.parse_account("ig @ronaldo"),
            ("instagram", "ronaldo", "https://www.instagram.com/ronaldo"),
        )
        self.assertEqual(
            bot.parse_account("https://www.instagram.com/cristiano/?igsh=MWx5eg=="),
            ("instagram", "cristiano", "https://www.instagram.com/cristiano"),
        )
        self.assertEqual(
            bot.parse_account("instagram.com/_u/deep_link_user"),
            ("instagram", "deep_link_user", "https://www.instagram.com/deep_link_user"),
        )

    def test_short_link_resolution(self):
        with patch.object(bot, "resolve_short_link", return_value="https://www.tiktok.com/@short_resolved?_t=123"):
            platform, identifier, url = bot.parse_account("https://vt.tiktok.com/ZSjNxxxx/")
            self.assertEqual(platform, "tiktok")
            self.assertEqual(identifier, "short_resolved")

    def test_button_states_and_handling(self):
        chat_id = 99999
        # Bấm nút Instagram
        reply, _ = bot.handle("📸 Check Instagram", None, "", "v24.0", chat_id=chat_id)
        self.assertIn("Instagram", reply)
        self.assertEqual(bot.USER_STATES.get(chat_id), "ig")

        # Gửi tiếp username
        with patch.object(bot, "check_live_status", return_value=("LIVE", "OK")):
            reply, kb = bot.handle("cristiano", None, "", "v24.0", chat_id=chat_id)
            self.assertIn("cristiano", reply)
            self.assertNotIn(chat_id, bot.USER_STATES)
            self.assertIsNotNone(kb)

    def test_live_command(self):
        with patch.object(bot, "check_live_status", return_value=("LIVE", "Tài khoản đang hoạt động")):
            reply, _ = bot.handle("/live ig cristiano", None, "", "v24.0")
            self.assertIn("🟢 <b>LIVE</b>", reply)
            self.assertIn("cristiano", reply)

        with patch.object(bot, "check_live_status", return_value=("DIE", "Không tìm thấy trang hồ sơ (HTTP 404)")):
            reply, _ = bot.handle("/live tt @dead_acc", None, "", "v24.0")
            self.assertIn("🔴 <b>DIE</b>", reply)

    def test_batch_check_live_die(self):
        mock_returns = {
            ("tiktok", "live_user"): ("LIVE", "OK"),
            ("instagram", "dead_user"): ("DIE", "404 Not Found"),
        }
        def fake_check(platform, iden):
            return mock_returns.get((platform, iden), ("UNKNOWN", "Test"))

        with patch.object(bot, "check_live_status", side_effect=fake_check):
            raw_text = "tt @live_user\nig dead_user"
            reply, _ = bot.handle(raw_text, None, "", "v24.0")
            self.assertIn("BÁO CÁO QUÉT LIVE / DIE HÀNG LOẠT", reply)
            self.assertIn("LIVE:</b> <code>1</code>", reply)
            self.assertIn("DIE:</b> <code>1</code>", reply)

    def test_tiktok_formats_all_returned_fields(self):
        client = bot.TikTokResearch("key", "secret")
        with patch.object(client, "lookup", return_value={
            "display_name": "Người dùng", "follower_count": 100,
            "likes_count": 250, "is_verified": False,
        }):
            reply, _ = bot.handle("/check tt @tester", client, "", "v24.0")
        self.assertIn("100", reply)
        self.assertIn("250", reply)

    def test_instagram_public_scraping(self):
        fake_html = '<meta property="og:title" content="Test User (@tester) • Instagram profile"><meta name="description" content="500K Followers, 200 Following, 150 Posts - See photos">'
        with patch.object(bot, "urlopen") as mock_url:
            mock_resp = MagicMock()
            mock_resp.read.return_value = fake_html.encode("utf-8")
            mock_url.return_value.__enter__.return_value = mock_resp
            info = bot.lookup_instagram_public("tester")

        self.assertIsNotNone(info)
        self.assertEqual(info["follower_count"], "500K")
        self.assertEqual(info["following_count"], "200")
        self.assertEqual(info["video_count"], "150")

    def test_tiktok_public_scraping(self):
        fake_html = '<meta property="og:title" content="TikToker on TikTok"><meta name="description" content="@tiktoker 1.2M Followers, 50 Following, 10.5M Likes - Watch short videos">'
        with patch.object(bot, "urlopen") as mock_url:
            mock_resp = MagicMock()
            mock_resp.read.return_value = fake_html.encode("utf-8")
            mock_url.return_value.__enter__.return_value = mock_resp
            info = bot.lookup_tiktok_public("tiktoker")

        self.assertIsNotNone(info)
        self.assertEqual(info["follower_count"], "1.2M")
        self.assertEqual(info["following_count"], "50")
        self.assertEqual(info["likes_count"], "10.5M")


if __name__ == "__main__":
    unittest.main()
