# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.4.3] - 2026-11-27

### Changed
- First npm release as `dsh-remote-ssh-plugin`. The shorter names
  `dsh-ssh-remote`, `dsh-remote-ssh`, `dsh-ssh-workspace` and
  `dsh-remote-workspaces` are owned by other authors, so the package uses this
  name; the bundle patch, docs and market index follow it.

## [1.4.2] - 2026-11-27

### Fixed
- Prompt text and tool descriptions named the row's seed machine (`ssh-host`)
  instead of the machine the GUI-managed registry actually defaults to, so an
  installed bundle could describe the wrong primary machine after the GUI
  replaced the seed.

## [1.4.1] - 2026-11-27

First public release on GitHub.

### Added
- Settings panel UI rework: one-dialog machine creation with optional remote
  directory, connection pills with probe detail, "Test all", auto-probe on open,
  remote-workspace management with re-register and two-step removal.
- Remote directory browser: click/double-click selection, typed path, home/root/up
  jumps, breadcrumbs, hidden-directory switch, inline folder creation, in-flight
  guards, failures stay in the dialog with retry.
- Symlinked directories are listed and enterable.
- Offline self-test mode (`--offline`) and GitHub Actions CI on Node 22/24.
- Plugin-market index generator (`scripts/make-index.mjs`).
- MIT license, bilingual README, changelog.

### Fixed
- Escape no longer closes several dialogs and the Settings shell at once; dialogs
  stack, trap focus, restore focus and lock page scroll.
- Corrected nonexistent theme tokens (primary button contrast, warning colour,
  selection background); cards now use the host settings-card tokens.
- Restored the input focus ring.
- Mutation buttons are disabled while a request runs; a failed directory choice no
  longer closes the browser.
- Backend diagnostics are translated in the panel; notices are dismissible and
  errors persist.
- Last machine cannot be removed; machine removal cascades to its remote
  workspaces with a visible warning.

## [1.4.0] - 2026-11-27

### Added
- One-request machine create/update with remote-directory validation, workspace
  registration in the same call, re-register endpoint, machine-removal cascade.
- Ad-hoc browsing of an unsaved machine's destination.

## [1.3.0] - 2026-11-27

### Added
- Remote workspaces: choosing a remote directory registers a real DSH workspace
  backed by a local mirror directory; sessions opened there bind to the remote
  directory, `remote_*` tools default to it, and local file/shell tools are hidden
  with a session-scoped prompt explaining the binding.

## [1.2.0] - 2026-11-27

### Added
- Settings panel (`settings.section`) with machine list, add/edit/remove, SSH
  connection test, remote directory browser, workspace list, host HTTP API.

## [1.1.0] - 2026-11-27

### Added
- Multiple machines per plugin row (`hosts` config) and an optional `host` argument
  on every tool.

## [1.0.2] - 2026-11-27

### Fixed
- Every model turn failed with `Cannot read properties of undefined (reading 'get')`:
  the prompt-section provider assumed a different callback shape. The section text is
  now static/guarded, and a contract self-test reproduces the regression offline.

## [1.0.0] - 2026-11-27

### Added
- Initial bundle: `remote_*` tools (exec, read, write, edit, grep, glob, upload,
  download, status) over OpenSSH with connection multiplexing.
