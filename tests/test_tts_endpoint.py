import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import server


class EdgeTtsEndpointTests(unittest.TestCase):
    def test_library_points_at_new_microsoft_host(self):
        try:
            import edge_tts.communicate as comm
        except ImportError:
            self.skipTest("edge-tts not installed")
        self.assertNotIn("speech.platform.bing.com", comm.WSS_URL)
        self.assertIn("api.msedgeservices.com", comm.WSS_URL)
        self.assertIn("Ocp-Apim-Subscription-Key=", comm.WSS_URL)

    def test_patch_is_a_no_op_once_applied(self):
        self.assertFalse(server.use_new_edge_tts_endpoint())


if __name__ == "__main__":
    unittest.main()
