# Smoke Monkey AI IDE — UI/Product Audit

## Overview
160+ hardcoded "Visual Studio Code"/"VS Code" strings remain in source. `product.json` is fully rebranded. Most visible strings come from NLS `localize()` calls in TypeScript source files.

---

## 1. Product Identity (product.json) — REBRANDED ✓
All name fields correctly set to "Smoke Monkey". Residual: `webviewContentExternalBaseUrlTemplate` still references `vscode-cdn.net`.

## 2. Title Bar — DYNAMIC ✓
Window title resolves from `product.json` nameLong via template. Shows "Smoke Monkey AI IDE — project-name".

## 3. Application Menu — VS CODE STRINGS
- `src/vs/workbench/browser/actions/helpActions.ts:165` — "Signup for the VS Code Newsletter" (dormant, no URL set)
- Help > Getting Started description: "Opens a Walkthrough to help you get started in VS Code."
  File: `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts:53`

## 4. Command Palette — CLEAN
Smoke Monkey Agent commands registered via extension. No VS Code AI commands visible by default.

## 5. Activity Bar — STANDARD VS CODE ORDER
Default: Explorer, Search, Source Control, Run/Debug, Extensions, Smoke Monkey Agent.
No Smoke Monkey Agent in primary position.

## 6. Side Bar — CLEAN (extensions view shows Microsoft publisher names)

## 7. Panel — CLEAN

## 8. Status Bar — NO SMOKE MONKEY INDICATOR
No agent status indicator present.

## 9. Welcome Page — MIXED
- Title resolves to "Smoke Monkey AI IDE" from product.json ✓
- Subtitle "Editing evolved" (VS Code tagline) — needs replacement
- Copilot setup step: "Use AI features with Copilot for free" — needs replacement
- Video tutorial link points to `aka.ms/vscode-getting-started-video`
- "Generate New Workspace" links to chat setup

## 10. Walkthroughs — VS CODE REFERENCES
- `gettingStarted.contribution.ts:323` mentions "VS Code" in settings description
- `gettingStarted.contribution.ts:53` command description says "VS Code"

## 11. Agent UI — EXTENSION-BASED
Smoke Monkey Agent panel exists as extension webview. No native integration.

## 12. Extensions UI — CLEAN (shows "Microsoft" publisher names from bundled extensions)

## 13. Settings — 159 NLS MESSAGES WITH "VS Code"
High-visibility:
- Terminal config descriptions (10+ occurrences)
- Workspace trust descriptions
- Extensions config
- Welcome page description
- MCP servers view links to `code.visualstudio.com`

## 14. Keyboard Shortcuts — CLEAN

## 15. Notifications — VS CODE REFERENCES
- `nativeExtensionService.ts:168` — "Relaunch VS Code" button
- `update.ts:421-457` — "VS Code" in update notifications

## 16. Accounts — CLEAN

## 17. Help/About — CLEAN (resolves from product.json)

## 18. Update UI — VS CODE REFERENCES
- `src/vs/workbench/contrib/update/browser/update.ts:421-457` — multiple "VS Code" strings

## 19. Command IDs — CLEAN

## 20. Product Metadata — `src/vs/platform/product/common/product.ts:81-82`
Dev fallback: `nameShort: 'Code - OSS Dev'`, `nameLong: 'Code - OSS Dev'`

## 21. Icons — REBRANDED ✓
`code-icon.svg` replaced with SM logo. `vscode-icon.svg` has monkey face.

## 22. Logos — REBRANDED ✓
`smokeMonkeyLogo.png` wired to all locations.

## 23. Default Extensions — MICROSOFT PUBLISHER NAMES
Bundled extensions show "Microsoft" as publisher in Extensions view.

## 24. Default Welcome Content — COPILOT SETUP STEP
`createCopilotSetupStep()` in `gettingStartedContent.ts:228-234` — "Use AI features with Copilot for free"

## 25. GitHub Copilot References
### Category A — Visible default UI:
- Welcome page Copilot setup step (gettingStartedContent.ts:228-234)
- `_disabled-copilot/` extension directory (renamed from copilot)

### Category B — Optional extension integration:
- Copilot compatibility APIs in extension service (KEEP)

### Category C — Extension APIs:
- Copilot extension APIs (KEEP)

### Category D — Documentation/legal:
- upstream Code OSS references (KEEP)

## 26. Claude References
- No Claude Code references found in current build.

## 27. Other Third-Party AI References
- `chatPetWidget.ts` — 23 occurrences of "VS Code pet" (experimental feature)

## 28. Browser HTML
- `callback.html:10,115` — "Visual Studio Code" title and branding
- `workbench.html:13` — apple-mobile-web-app-title "Code"

## 29. Windows/Linux
- `resources/win32/VisualElementsManifest.xml:8` — "Code - OSS"
- `build/win32/i18n/messages.*.isl` — "Updating Visual Studio Code..."
- `resources/linux/code-url-handler.desktop` — tagline + keywords

## 30. Internal (not user-visible)
- `main.ts`, `app.ts`, `cli.ts` — internal logs
- Test fixtures
- Comments

---

## Priority User-Visible Fixes

| Priority | Location | Current | Action |
|---|---|---|---|
| 1 | Welcome page Copilot step | "Use AI features with Copilot for free" | REPLACE with Smoke Monkey Agent |
| 2 | Welcome page subtitle | "Editing evolved" | REPLACE |
| 3 | Getting Started command desc | "VS Code" | REPLACE |
| 4 | Status bar | No agent indicator | ADD Smoke Monkey Agent indicator |
| 5 | Activity Bar order | Agent is last | MOVE to first position |
| 6 | Settings descriptions | 159 "VS Code" strings | REPLACE key ones |
| 7 | Update notifications | "VS Code" | REPLACE |
| 8 | Relaunch notification | "Relaunch VS Code" | REPLACE |
| 9 | Product fallback defaults | "Code - OSS Dev" | REPLACE |
| 10 | Browser callback page | "Visual Studio Code" | REPLACE |
| 11 | Windows manifest | "Code - OSS" | REPLACE |
| 12 | Linux desktop entry | VS Code tagline | REPLACE |
| 13 | Chat pet strings | "VS Code pet" | REPLACE or REMOVE |
