#!/usr/bin/env python3
import json
import re
import subprocess
import sys
from collections import defaultdict


class PRAnalyzer:
    def analyze_changes(self, base_branch="main"):
        """
        Analyze changes between current branch and base
        """
        analysis = {
            "files_changed": self._get_changed_files(base_branch),
            "change_statistics": self._get_change_stats(base_branch),
            "change_categories": self._categorize_changes(base_branch),
        }

        return analysis

    def _get_changed_files(self, base_branch):
        """Get list of changed files with statistics"""
        cmd = f"git diff --name-status {base_branch}...HEAD"
        result = subprocess.run(cmd.split(), capture_output=True, text=True)

        files = []
        for line in result.stdout.strip().split("\n"):
            if line:
                parts = line.split("\t", 1)
                if len(parts) == 2:
                    status, filename = parts
                    files.append(
                        {
                            "filename": filename,
                            "status": self._parse_status(status),
                            "category": self._categorize_file(filename),
                        }
                    )

        return files

    def _parse_status(self, status):
        """Parse git status code"""
        status_map = {"A": "Added", "M": "Modified", "D": "Deleted", "R": "Renamed", "C": "Copied"}
        return status_map.get(status[0], "Unknown")

    def _get_change_stats(self, base_branch):
        """Get detailed change statistics"""
        cmd = f"git diff --shortstat {base_branch}...HEAD"
        result = subprocess.run(cmd.split(), capture_output=True, text=True)

        # Parse output like: "10 files changed, 450 insertions(+), 123 deletions(-)"
        stats_pattern = (
            r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?"
        )
        match = re.search(stats_pattern, result.stdout)

        if match:
            files, insertions, deletions = match.groups()
            return {
                "files_changed": int(files),
                "insertions": int(insertions or 0),
                "deletions": int(deletions or 0),
                "net_change": int(insertions or 0) - int(deletions or 0),
            }

        return {"files_changed": 0, "insertions": 0, "deletions": 0, "net_change": 0}

    def _categorize_file(self, filename):
        """Categorize file by type"""
        categories = {
            "source": [".js", ".ts", ".py", ".java", ".go", ".rs", ".c", ".cpp"],
            "test": ["test", "spec", ".test.", ".spec."],
            "config": ["config", ".json", ".yml", ".yaml", ".toml"],
            "docs": [".md", "README", "CHANGELOG", ".rst"],
            "styles": [".css", ".scss", ".less"],
            "build": ["Makefile", "Dockerfile", ".gradle", "pom.xml"],
        }

        for category, patterns in categories.items():
            if any(pattern in filename for pattern in patterns):
                return category

        return "other"

    def _categorize_changes(self, base_branch):
        files = self._get_changed_files(base_branch)
        changes_by_category = defaultdict(list)
        for f in files:
            changes_by_category[f["category"]].append(f)
        return dict(changes_by_category)


def _infer_base() -> str:
    """Infer base branch from context: PR base, origin HEAD, or upstream, fallback main."""
    for cmd in [
        ["gh", "pr", "view", "--json", "baseRefName", "-q", ".baseRefName"],
        ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    ]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=3)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.strip().split("/")[-1].split(":")[0]
        except Exception:
            continue
    return "main"


def _is_pr_target(arg: str) -> bool:
    return arg.isdigit() or ("github.com" in arg and "/pull/" in arg)


def _analyze_pr_via_gh(target: str) -> dict:
    """Fetch PR files/stats via gh, fallback to git diff."""
    try:
        r = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                target,
                "--json",
                "files,additions,deletions,changedFiles,baseRefName",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip():
            data = json.loads(r.stdout)
            files = []
            for f in data.get("files", []):
                # gh files: {path, additions, deletions, state: added/modified/renamed...}
                raw_state = str(f.get("state", "modified")).lower()
                status = {
                    "added": "Added",
                    "modified": "Modified",
                    "deleted": "Deleted",
                    "renamed": "Renamed",
                }.get(raw_state, "Modified")
                filename = f.get("path", "")
                # categorize via PRAnalyzer helper
                analyzer = PRAnalyzer()
                files.append(
                    {
                        "filename": filename,
                        "status": status,
                        "category": analyzer._categorize_file(filename),
                    }
                )
            stats = {
                "files_changed": int(data.get("changedFiles", len(files))),
                "insertions": int(data.get("additions", 0)),
                "deletions": int(data.get("deletions", 0)),
                "net_change": int(data.get("additions", 0)) - int(data.get("deletions", 0)),
            }
            # categories
            cats = {}
            for fi in files:
                cats.setdefault(fi["category"], []).append(fi)
            return {"files_changed": files, "change_statistics": stats, "change_categories": cats}
    except Exception:
        pass
    # fallback: try gh pr diff stat
    try:
        r = subprocess.run(
            ["gh", "pr", "diff", target, "--stat"], capture_output=True, text=True, timeout=5
        )
        if r.returncode == 0:
            return {
                "files_changed": [],
                "change_statistics": {
                    "files_changed": 0,
                    "insertions": 0,
                    "deletions": 0,
                    "net_change": 0,
                },
                "change_categories": {},
                "raw_stat": r.stdout[:2000],
            }
    except Exception:
        pass
    return {"error": f"cannot fetch PR {target}"}


if __name__ == "__main__":
    raw_arg = sys.argv[1] if len(sys.argv) > 1 else _infer_base()
    if _is_pr_target(raw_arg):
        try:
            print(json.dumps(_analyze_pr_via_gh(raw_arg), indent=2))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)
    base_branch = raw_arg
    analyzer = PRAnalyzer()
    try:
        analysis = analyzer.analyze_changes(base_branch)
        print(json.dumps(analysis, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
