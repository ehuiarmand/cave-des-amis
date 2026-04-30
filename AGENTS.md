# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is a single-file Python/Streamlit inventory management application ("Gestion de Stock Multi-Utilisateur"). It uses local JSON files for persistence (no database required).

### Running the application

```
streamlit run app_stock_multi_user.py --server.headless true --server.port 8501
```

The app serves on port 8501. Use `--server.headless true` to suppress the browser-open prompt in headless environments.

### Default accounts

See `README.md` for credentials. Admin: `admin`/`admin123`.

### Key caveats

- Data is stored in `users.json` and `stock_initial.json` in the working directory. These files are modified in-place by the app at runtime — be mindful of concurrent access during testing.
- There is no database, no migrations, and no build step.
- There are no automated tests in this repository. Validation is done manually via the Streamlit UI.
- The app must be run from the `/workspace` directory so it can find the JSON data files (relative path references).

### Lint / Test / Build

- **Lint**: No linting configuration exists in the repo. You may run `python -m py_compile app_stock_multi_user.py` to verify syntax.
- **Tests**: No test suite exists. Manual testing via the UI is the only option.
- **Build**: No build step required — Streamlit runs the Python file directly.
