# Releasing Prismaxim

Releases are **automated from `main`**. The GitHub Actions workflow
[`.github/workflows/release.yml`](.github/workflows/release.yml) runs on every push
to `main` and publishes a release **only when the version is new**.

## Branch model

- **`dev`** — integration branch. Do day-to-day work here (feature branches can also
  merge into `dev`).
- **`main`** — release branch. Promoting `dev` → `main` is what ships a release.

## Cutting a release

1. On `dev`, bump the version in **both** `package.json` and `desktop/package.json`
   (keep them in sync), e.g. `0.2.0` → `0.2.1`. Commit as `release: v0.2.1`.
2. Merge `dev` into `main` (open a PR `dev` → `main` and merge, or fast-forward).
3. The push to `main` triggers the workflow. It sees a version whose `v<version>` tag
   doesn't exist yet, so it:
   - builds the Windows desktop installer (`cd desktop && npm run dist` → NSIS `.exe`),
   - creates the git tag `v<version>`,
   - publishes a **GitHub Release** with auto-generated notes and the installer attached.

Pushing to `main` **without** bumping the version is a no-op — the workflow skips the
build because the tag already exists. So merging docs/hotfix commits to `main` won't
accidentally re-release.

You can also run the workflow manually from the **Actions → Release → Run workflow**
button (still gated on the version being new).

## Code signing (optional)

The installer is unsigned by default (Windows SmartScreen warns on first run). To sign
in CI, add repository secrets `CSC_LINK` (base64 of the `.pfx`) and `CSC_KEY_PASSWORD`,
then expose them as env in the "Build Windows installer" step — electron-builder signs
automatically when it finds them. See [DESKTOP.md](DESKTOP.md#code-signing-removes-the-smartscreen-warning).
