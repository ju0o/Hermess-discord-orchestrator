# Windows operation

First validate interactive startup with `npm start` and `npm run health`. Keep the machine awake and ensure the account running the Runtime owns the authenticated Worker CLI sessions.

After interactive validation, an operator may register the included logon task from the repository directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup-task.ps1
```

The task uses the current interactive Windows account. It does not configure passwords, auto-logon, or unattended service credentials. Stop the task through Windows Task Scheduler or stop the interactive Runtime cleanly before maintenance. Back up the SQLite data directory with a SQLite-aware method; never commit it.
