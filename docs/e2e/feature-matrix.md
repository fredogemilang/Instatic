# User E2E Feature Matrix

Use this matrix to choose agent-browser audit scope. Rows are user goals. Keep steps concrete enough to run, but avoid implementation details.

## Priority Key

| Priority | Meaning |
|---|---|
| P0 | Must work before any usable release. |
| P1 | Core CMS/editor workflow. |
| P2 | Important product workflow. |
| P3 | Polish, edge case, or later hardening. |

## Core Owner Lifecycle

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| SETUP-001 | P0 | Setup | Create the first site and owner account | Clean DB | Open `/admin`, complete setup | User lands in admin/editor with clear success path | confusing labels, weak validation, redirect loops |
| AUTH-001 | P0 | Auth | Log out and log back in | Setup complete | Account menu, logout, login | Session ends, login restores access | unclear session state, cookie issues |
| EDIT-001 | P0 | Editor | Add visible text to the homepage | Logged in | Open editor, use visible controls | Text appears on canvas and survives reload | hidden controls, no save feedback, data loss |
| EDIT-002 | P1 | Editor | Add a button and change its label/link | Logged in | Insert button, edit properties | Button renders with intended label and link | wrong panel labels, focus loss, invalid link handling |
| SAVE-001 | P0 | Persistence | Reload after edits | Edited draft | Browser reload | Draft content remains editable | autosave uncertainty, stale state |
| PUB-001 | P0 | Publish | Publish homepage | Edited draft | Publish flow | Success feedback appears | no progress state, unclear success/failure |
| PUB-002 | P0 | Public Site | Visit published homepage as a visitor | Published site | Open public route | Public page shows published content without admin chrome | draft leakage, missing CSS, broken assets |
| PUB-003 | P1 | Draft Safety | Make an unpublished draft change | Published page exists | Edit draft, do not publish, open public route | Public page still shows last published version | draft/public mismatch |

## Admin Shell And Account

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| ADMIN-001 | P1 | Navigation | Move between Site, Content, Plugins, Users, Account | Logged in | Admin navigation | Active page and breadcrumbs are clear | dead links, unclear active state |
| ADMIN-002 | P2 | Account | Change account profile basics | Logged in | Account page | Changes save and persist | missing feedback, validation copy |
| ADMIN-003 | P2 | Security | Start and cancel MFA setup | Logged in | Account security | Flow is understandable and cancelable | scary copy, stuck modal |
| ADMIN-004 | P2 | Users | Create a non-owner user | Owner logged in | Users page | New user appears with intended role | role confusion, unsafe defaults |

## Page And Site Management

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| PAGE-001 | P1 | Pages | Create a new page | Logged in | Site/page navigation | Page appears with editable title and slug | duplicate slug handling, title focus |
| PAGE-002 | P1 | Pages | Rename and open a page | Multiple pages | Page actions | Navigation and public/open actions use the new slug | stale URL, broken context menu |
| PAGE-003 | P2 | Pages | Delete a page safely | Multiple pages | Page actions | Clear confirmation or undo path, no broken selection | accidental destructive action |
| PAGE-004 | P2 | Pages | Switch between pages after unsaved edits | Multiple pages | Edit then navigate | User understands save state and does not lose work | silent data loss |

## Visual Builder

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| BUILDER-001 | P1 | Insert | Add common modules: container, text, image, button | Logged in | Module picker | Modules appear where expected | insertion ambiguity, bad empty states |
| BUILDER-002 | P1 | Selection | Select canvas nodes and edit properties | Page with modules | Canvas and properties panel | Selection is obvious and property edits apply | lost selection, wrong node edited |
| BUILDER-003 | P1 | DOM Panel | Reorder nodes in the tree | Page with nested modules | DOM panel drag/drop | Canvas order matches tree order | impossible drop targets, bad affordance |
| BUILDER-004 | P1 | Canvas Drag | Reorder nodes directly on canvas | Page with modules | Canvas drag/drop | Drop target and final order are clear | jumpy drag, scroll/zoom conflict |
| BUILDER-005 | P1 | Undo/Redo | Undo and redo edits | Edited page | Toolbar/shortcuts | State moves predictably backward/forward | partial undo, UI desync |
| BUILDER-006 | P2 | Styling | Apply spacing, color, and typography | Selected node | Properties and class controls | Visual result matches settings | token label confusion, no preview |
| BUILDER-007 | P2 | Breakpoints | Edit mobile/tablet/desktop variants | Page with content | Breakpoint selector | Variant changes are scoped and understandable | accidental global change, clipped UI |
| BUILDER-008 | P2 | Rich Text | Edit formatted text | Text module | Rich text controls | Formatting persists and publishes cleanly | toolbar confusion, sanitization surprises |

## Media

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| MEDIA-001 | P1 | Uploads | Upload an image and place it on a page | Logged in | Image/media control | Image previews in editor and public page | broken preview, path leakage |
| MEDIA-002 | P2 | Uploads | Try unsupported file upload | Logged in | Media control | User gets clear validation feedback | vague errors, security footguns |
| MEDIA-003 | P2 | Media Library | Reuse an uploaded asset | Existing upload | Media picker | Asset can be selected without re-upload | missing search, stale thumbnails |

## Content CMS

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| CONTENT-001 | P1 | Posts | Create a post | Logged in | Content page | Post saves with title/body/status | editor mismatch, missing status feedback |
| CONTENT-002 | P1 | Posts | Publish or expose post content where supported | Existing post | Content plus site preview | Content appears only where intended | draft leakage, unclear publish model |
| CONTENT-003 | P2 | Collections | Add or edit collection fields | Logged in | Content collections | Field changes are validated and understandable | destructive schema changes |

## Plugins

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| PLUGIN-001 | P1 | Plugins | Upload and activate a valid plugin | Logged in, test plugin zip | Plugins page | Plugin appears active with clear permissions | scary/unclear permission review |
| PLUGIN-002 | P1 | Plugins | Use a plugin-provided module or admin UI | Active plugin | Editor/plugins UI | Plugin feature appears and works | runtime crash, unclear placement |
| PLUGIN-003 | P2 | Plugins | Deactivate/uninstall a plugin | Active plugin | Plugins page | UI explains impact and completes safely | orphaned UI, missing cleanup |
| PLUGIN-004 | P2 | Plugins | Upload invalid plugin package | Logged in | Plugins page | Error is specific and recoverable | generic failure, stuck upload |

## Responsive And Accessibility Passes

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| A11Y-001 | P1 | Keyboard | Complete setup/login with keyboard | Clean/setup DB | Keyboard only | Focus order and submit behavior work | focus traps, invisible focus |
| A11Y-002 | P2 | Editor | Navigate main admin shell with keyboard | Logged in | Keyboard only | Core navigation is reachable | custom controls without roles |
| RESP-001 | P2 | Responsive | Use admin at tablet width | Logged in | 768px viewport | Main flows remain usable | clipped panels, overlapping text |
| RESP-002 | P2 | Responsive | Preview/publish mobile page | Published page | 390px viewport | Public page is readable and styled | overflow, broken media |

## Command Palette (⌘K Spotlight)

Full scenario descriptions and per-assertion steps live in `docs/e2e/spotlight.md`.

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| SPOT-001 | P1 | Open/Close | Open palette with ⌘K and close with Esc | Logged in | ⌘K → Esc | Palette opens, input focused, Esc closes, focus restored | Focus trap failures; palette fails to open |
| SPOT-002 | P1 | Navigation | Type a query and navigate to a workspace | Logged in | Open palette, type, Enter | Correct workspace opened; palette closed | Wrong navigation; palette left open |
| SPOT-003 | P2 | Subcommand | Push a scope and pick an item | Site workspace with breakpoints | Open palette, drill into "Switch breakpoint →" | Breakpoint changes; palette closes | Scope push fails; wrong item selected |
| SPOT-004 | P1 | Destructive | Two-Enter confirm flow for a destructive command | Multiple pages exist | Open palette, destructive command, Enter×2 | First Enter shows confirm; second runs | No confirm shown; double-fire |
| SPOT-005 | P2 | Destructive timeout | Confirm collapses after 5 s without second Enter | Active confirm state | Wait >5 s | Confirm prompt disappears | Timer off; row stuck |
| SPOT-006 | P1 | Empty state | No-match query shows empty state | Logged in | Open palette, type nonsense string | Empty-state UI with quoted query | Empty state missing; wrong empty state |
| SPOT-007 | P2 | Context ranking | Duplicate-layer command boosted with node selected | Editor, node selected | Open palette | "Duplicate selected layer" near top | Command missing; not boosted |
| SPOT-008 | P2 | Recents | Recent commands at top on re-open | Run one command | Close and reopen palette | Recent group with prior command visible | Recents not persisted; duplicates |

## Performance And Reliability

| ID | Priority | Area | User Goal | Setup | Path | Expected Outcome | Watch For |
|---|---:|---|---|---|---|---|---|
| PERF-001 | P2 | Editor Load | Open editor from cold start | Setup complete | `/admin` | App becomes usable without long blank state | spinner dead ends, console errors |
| PERF-002 | P2 | Publish | Publish a moderately complex page | Page with nested modules/media | Publish | Operation gives feedback and completes | no progress, timeout, duplicate clicks |
| REL-001 | P2 | Recovery | Refresh during normal editing | Editing session | Reload | App recovers to a coherent state | corrupt draft, lost selection crash |
| REL-002 | P3 | Error Handling | Trigger validation errors intentionally | Various forms | Bad input | Errors are specific and close to fields | global vague errors |
