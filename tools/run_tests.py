"""Run the repo's unittest suite from anywhere, against a throwaway database."""
import os
import sys
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# tools/shots/ is gitignored, so a fresh clone or worktree has no such folder and every test that
# opens the database fails with "unable to open database file". Make it before anything connects.
os.makedirs(os.path.join(REPO, "tools", "shots"), exist_ok=True)
os.environ.setdefault("READER_DB_PATH", os.path.join(REPO, "tools", "shots", "test-run.db"))
os.chdir(REPO)
sys.path.insert(0, REPO)

sys.path.insert(0, os.path.join(REPO, "tests"))
loader = unittest.TestLoader()
suite = loader.discover(os.path.join(REPO, "tests"), top_level_dir=os.path.join(REPO, "tests"))
result = unittest.TextTestRunner(verbosity=1).run(suite)
print("\nTOTALS run=%d failures=%d errors=%d skipped=%d"
      % (result.testsRun, len(result.failures), len(result.errors), len(result.skipped)))
sys.exit(0 if result.wasSuccessful() else 1)
