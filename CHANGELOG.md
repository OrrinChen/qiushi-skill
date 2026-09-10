# Changelog

## Unreleased

### Fixed

- Add a guarded `--adopt-legacy` migration for verified pre-manifest Codex installs, including Git and CRLF-normalized npm 1.3.1 trees. Existing files are backed up before the managed install is written.
- Validate every target, manifest, asset, and conflict before replacing files; stage all copy targets, including bundles, in one transaction and roll them back on ordinary filesystem errors.
- Resolve managed roots to their physical locations before writing, reject overlapping roots reached through symlinks, and refuse symlinked dedicated bundle roots.
- Replace manifests through same-directory temporary files so read-only files cannot cause a late partial install, and reject symlinked or malformed manifests before mutation.
- Restore executable permissions for both Unix hook files after bundle installation, including npm tarballs that normalize modes to `0644`; document Bash as the Unix runtime.
- Keep host system, developer, and safety rules above user and methodology instructions.
- Make named sub-agent guidance degrade safely on hosts that install only `skills/*`.
- Track this changelog in Git and validate Markdown references across skills, agents, and commands.

## [2.0.0] - 2026-09-06

### Changed

- Rewrote all methodology skills around explicit triggers, non-triggers, observable artifacts, and handoff conditions.
- Compressed `arming-thought` into a small routing kernel and added the fact / inference / unknown distinction.
- Changed `workflows` from three mandatory pipelines to four skippable patterns, including stage retrospective.
- Consolidated platform documentation into `docs/platforms.md`.

### Added

- Added the `investigator` read-only sub-agent.
- Added direct managed installation for Codex, OpenCode, OpenClaw, Hermes Agent, and nanobot.
- Added Node-based install, uninstall, validation, and package tests.

### Removed

- Removed three duplicated, host-undiscoverable `skills/*/*-prompt.md` files in favor of host-discoverable agents and self-contained fallback instructions.
- Removed duplicated per-platform installation documents.

## [1.4.1] - 2026-04-30

### Fixed

- Allowed validation to run from the published npm package without unpublished documentation files.

## [1.4.0] - 2026-04-30

### Added

- Added direct multi-platform installation and `.qiushi-skill-install.json` manifests for bounded uninstall.
- Added Node tests for installation and uninstallation.

## [1.3.0] - 2026-04-14

### Added

- Added the npm CLI, Claude marketplace metadata, English README, and OpenClaw/Hermes integration.

## [1.2.0] - 2026-03-26

### Added

- Added Windows PowerShell hooks, slash commands, cross-platform validation, and Codex/OpenCode guidance.

## [1.1.0] - 2026-03-25

### Changed

- Moved long source excerpts out of the main skill entry points to reduce context use.

## [1.0.0] - 2026-03-25

### Added

- Initial release with one entry skill and nine methodology skills.
