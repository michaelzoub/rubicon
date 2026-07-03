import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from seed_and_build import similarity  # noqa: E402


class SimilarityTests(unittest.TestCase):
    def test_handle_format_variants_match(self):
        self.assertGreaterEqual(similarity("ada_lovelace", "Ada Lovelace"), 0.64)
        self.assertGreaterEqual(similarity("grace.hopper", "Grace M. Hopper"), 0.64)

    def test_unrelated_names_do_not_match(self):
        self.assertLess(similarity("ada_lovelace", "Robin Forest"), 0.64)


if __name__ == "__main__":
    unittest.main()
