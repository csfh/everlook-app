import unittest

import risky_uses as risky

DIFF = """diff --git a/Everlook_X/x.lua b/Everlook_X/x.lua
--- a/Everlook_X/x.lua
+++ b/Everlook_X/x.lua
@@ -1,2 +1,6 @@
+local ok = loadstring(text)
+-- a comment that mentions SendMail is not a use
+TakeInboxMoney(index)
+local plain = 1 + 2
+RepairAllItems(false)
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1 +1,2 @@
+      - run: echo hi
diff --git a/gone.lua b/gone.lua
--- a/gone.lua
+++ /dev/null
@@ -1 +0,0 @@
-SendMail()
"""


class RiskyUsesTest(unittest.TestCase):
    def test_added_lines_are_listed_by_reason_and_comments_and_plain_lines_are_not(self):
        found = risky.scan(DIFF, "addon")
        reasons = [reason for reason, _ in found["Everlook_X/x.lua"]]
        self.assertEqual(reasons, ["runs text as code", "mail", "repair, selling, buying or deleting items"])

    def test_a_changed_workflow_is_listed_as_such(self):
        self.assertEqual(risky.scan(DIFF, "addon")[".github/workflows/ci.yml"][0][0], "a workflow or release script changed")

    def test_removed_lines_and_deleted_files_are_not_listed(self):
        self.assertNotIn("gone.lua", risky.scan(DIFF, "addon"))

    def test_the_app_profile_looks_for_what_matters_there(self):
        diff = "+++ b/src/main/x.ts\n+const child = spawn('x')\n+window = { webPreferences: { nodeIntegration: true } }\n"
        found = risky.scan(diff, "app")["src/main/x.ts"]
        self.assertEqual([reason for reason, _ in found], ["runs programs", "window security settings"])

    def test_a_clean_diff_says_so(self):
        self.assertIn("No added line", risky.render(risky.scan("+++ b/a.ts\n+const x = 1\n", "app")))

    def test_the_summary_never_raises(self):
        self.assertIn("### `Everlook_X/x.lua`", risky.render(risky.scan(DIFF, "addon")))


if __name__ == "__main__":
    unittest.main()
