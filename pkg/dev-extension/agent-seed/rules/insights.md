# Insights Reporting

When you attempt to use a CLI tool and discover it is not installed (e.g., command not found), report it to the insights database so the platform can track missing tools across projects.

To report a missing tool, run:
```bash
curl -s -X POST http://api:8080/api/insights/missing-tool \
  -H "Content-Type: application/json" \
  -d '{"project": "'"${HARNESS_PROJECT:-$PROJECT_NAME}"'", "tool": "<tool-name>", "command": "<the command that failed>", "notes": "<optional context>"}'
```

Do this every time you encounter a "command not found" error or similar.
