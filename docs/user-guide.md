# User guide

[한국어](user-guide.ko.md)

## Signing in and your account

- Open the **invite link** an administrator sent you to create your account. If company SSO is set up, use the SSO button on the sign-in page.
- **Forgot your password?**
  - Use **Forgot your password?** on the sign-in page to get a reset email. The link works once, for one hour.
  - If the link isn't there, email isn't set up. Ask an administrator for a reset link or a temporary password.
  - Signing in with a temporary password asks you to choose your own right away.
- **Your account** (your name, bottom left) is where you change:
  - Your name and profile photo. The photo is cropped square and shows in the sidebar, comments, mentions and notifications.
  - Theme (system, light, dark) and language (English, 한국어). These are saved to your account, so every device looks the same.
  - Your password, personal API tokens (see [AI agents](#ai-agents-mcp)) and email notifications (when email is set up).

## Home and the sidebar

You land on **Home** after signing in.

- **Recently viewed**: pages you opened last
- **For you**: places that mention you, reply to your comments, or change pages you watch
- **New pages**: recently created pages in spaces you can see
- The buttons at the top start a page from a template or open **Import**

**The sidebar, from the top:**
- space switcher
- search
- Home and Trash
- **Favorites**
- **Recently viewed**
- the page tree

Hide the sidebar with the panel button at its top right, or **⌘\\** / **Ctrl+\\**; the same brings it back (the choice is remembered in this browser). Drag the sidebar's right edge to make it wider, up to 40% of the window while the page keeps at least 720 px; double-click the edge to reset it.

The bell next to the space name counts unread notifications. You get one when someone mentions you, replies to your comment, comments on your page, or edits a page you watch.
- **By email**, if the server can send mail: unread notifications are bundled into one email a few minutes later. Turn it off in **Settings**.
- **In a chat tool**: in **Settings → Notifications to a chat webhook**, paste an incoming webhook URL from Slack, Mattermost, Microsoft Teams, Google Chat or Discord, click **Send test**, then **Save**. Addresses on the internal network work only if an administrator allows them (`WEBHOOK_ALLOW`).

## Spaces and pages

A **space** is the top level, usually one per team. Pages inside it form a tree.

| To | Do this |
|---|---|
| Switch or create a space | Click the space name, top left |
| Change who can see a space, or its members | Space name → **Space settings** (space admins) |
| Create a page | **New page** in the sidebar, or a template on **Home** |
| Create a subpage | **+** next to a page in the tree |
| Page menu | **⋯** next to a page in the tree: add subpage, copy link, make a copy, make a copy with subpages, move to trash |
| Move or reorder | Drag in the tree. Drop on the middle of a page to nest, on its top or bottom edge to place before or after |
| Delete and restore | **⋯ → Move to trash** (subpages included; **Undo** shows for a few seconds). Restore from **Trash** in the sidebar |
| Favorite | ☆ at the top of the page. Favorites gather in the sidebar |
| Page emoji | Hover above the title and click **Add icon**. It shows in the tree and favorites too |
| Labels | **Add label** under the title. Click a label to search for every page that has it |
| Watch | **Watching** at the top. You watch pages you create automatically, and get notified when they change |

- A copy appears next to the original as "Title (copy)".
- The text, attachments, labels, emoji and **view restrictions** come with it, so copying never lets more people see a page.

### Templates

- **Home** offers a blank page, weekly report, meeting notes and technical doc.
- Save a page you reuse with **⋯ → Save as template**, for this space or for every space.

## Writing

Pages **save automatically** when you stop typing. To save right away: **⌘S** / **Ctrl+S**.

### The toolbar and the `/` menu

Pages you can edit have a **toolbar** at the top that stays in view as you scroll.

| Toolbar group | What it does |
|---|---|
| Editing | Undo and redo |
| Text style | Body text, headings 1–3 |
| Text formatting | Bold, italic, strikethrough, code, highlight |
| Lists | Bullet, numbered, to-do |
| Insert | Table, image or file, code block |
| **+ Insert** | Every block: panels, diagrams, quotes, dividers and more |

Type `/` on an empty line for the same block menu. Keep typing to filter (`/table`, `/code`, `/표` all work).

| Block | Notes |
|---|---|
| Headings 1–3 | Appear in the **Contents** on the right |
| Bullet, numbered and to-do lists | Tab / Shift+Tab to indent |
| Table | Click inside for a menu: add or delete rows and columns, header row, merge cells (select by dragging or Shift+click) and split them, cell background color |
| Info, warning, success and danger panels | Click the panel icon to change the kind |
| Code block | Pick the language in the menu above it (about 45, from Bash, Python, Go and Java to PHP, Ruby, Swift and PowerShell). Hover for a **Copy** button, top right |
| Diagram | Write Mermaid syntax and the diagram draws below it |
| Link card | Paste a URL on an empty line to get a card with title, description and image |
| Image or file | Paste or drop it, too. Images show in the page; drag an image's bottom-right corner to resize it (double-click it for the original size) and type a caption under it. Other files become download links. Up to 50 MB each |

Selecting text opens a formatting menu: bold, italic, strikethrough, code, highlight, **link**, **comment**, headings.

| Type | Result |
|---|---|
| `# ` `## ` `### ` | Heading |
| `- ` / `1. ` / `[ ] ` | Bullet / numbered / to-do |
| `> ` / `` ``` `` / `---` | Quote / code block / divider |
| `@` | Mention someone |

| Shortcut | Action |
|---|---|
| ⌘K / Ctrl+K | Search |
| ⌘S / Ctrl+S | Save now |
| ⌘B, ⌘I | Bold, italic |
| ⌘Z / ⌘⇧Z | Undo / redo |
| Enter in the title | Jump to the body |
| ⌘Enter in a comment | Post it |

## Editing together

- When several people open the same page, they edit it **live**.
  - Everyone sees each other's cursors and names.
  - Typing at the same time never overwrites anyone.
  - The title updates for everyone.
- If the connection drops, your edits are kept in the browser and saved when it's back. If you closed the tab first, the page offers to restore them next time you open it.

## History

**History** at the top lists earlier versions. Saves by the same person within 10 minutes count as one version.

- **Changes** shows the lines that version changed.
- **Restore this version** brings it back. The current text stays in the history too.

## Comments

- **Page comments** are at the bottom of the page. Reply to them, and click **Resolve** on finished threads. Resolved threads stay folded until you open them.
- **Inline comments**: select text and click 💬 to comment on that passage. The passage is highlighted; click it to jump to its thread.
- **Resolving** a thread is up to whoever started it or anyone who can edit the page.
- **Deleted comments** can be brought back with **Undo** right after.

## Mentions and notifications

Type `@` in a page or comment and pick someone. Only people who can see the page get notified.

You're also notified when:
- someone replies to your comment
- someone comments on a page you created
- a page you watch changes

With email set up, unread notifications from the last few minutes go out as one email; turn them off in **Your account**.

## Who can see a space

Each space has a default for people who aren't members.

| Setting | Meaning |
|---|---|
| Everyone can edit | Everyone signed in can read and edit (default) |
| Everyone can view | Everyone can read; only **Edit** and **Admin** members change things |
| Private | Members only. It doesn't appear in anyone else's space list, search or Home |

- Members (people or **groups**) get **Admin** (manages the space), **Edit** or **View**.
- Whoever creates a space becomes its admin.
- A page is never more open than its space: page restrictions narrow access, never widen it.

## Who can see a page

1. Click **Access** at the top.
2. Choose **Only selected people**.
3. Add people or groups, each with **View** or **Edit**.

Rules:

- People not on the list can't find the page anywhere: sidebar, search, recent lists, trash, comments, history, attachments and exports.
- Pages **inside** a restricted page inherit its restrictions. You need to be allowed on every restricted page above.
- Moving a subpage out from under a restricted page would lift what it inherits, so **only administrators** can do that.
- Whoever sets the restriction keeps edit access. **Site administrators can open every page.**
- Restricted pages show a lock in the sidebar and at the top.

## Search

**Quick search:** press **⌘K** / **Ctrl+K** or click **Search**. The best matches appear as you type. **⌘Enter** (or **See all results**) opens the search page.

**The search page:**
- Finds pages containing **every** word.
- Handles Korean particles, so "배포를" also finds "배포는".
- Searches comments and attachment names too.

| Filter | Options |
|---|---|
| Space, last editor, updated | A specific value or any |
| Label | A label alone (no search words) lists every page that has it |
| Scope / sort | Title and text, or title only / relevance or newest |

The address keeps your words and filters, so you can bookmark a search or share it as a link.

## Import

**Where:** **Import** on Home, space menu → **Import pages…**, or a page's **⋯ → Import into this page**.

**What to give it:** drop in files or a ZIP, or **choose a folder** you unzipped.

| From | How to export | What comes across |
|---|---|---|
| **Confluence (recommended)** | Space settings → Export → CSV | Page and folder tree in order, attachments with their names, labels, links between pages, code, panels, expand, Jira, drawio, tasks and more |
| Confluence | Space settings → Export → HTML | Page tree, attachments and images, the common macros |
| A Confluence page | Page → Export → Markdown | The text (dynamic macros remain as links) |
| Notion | Settings → Export → Markdown & CSV | Subpage tree, images, links between pages |
| Markdown, HTML or text | Files, or a folder as a ZIP | Folders as parent pages, linked images and files uploaded, `[[wiki links]]` resolved, EUC-KR files and Korean names from Windows ZIPs handled |
| Pagehouse | Its export ZIP | Everything as it was |

- Import **only adds new pages** and never changes existing ones. If you don't like the result, move it to the trash and try again.
- When it finishes, **things to check** are grouped by reason, each saying what it means and what to do:
  - attachments over the 50 MB limit
  - files that weren't in the upload
  - links to pages in other spaces
- Confluence authors, dates, comments, permissions and history don't come across. The CSV export has no user names, so @mentions show as "@user".
- For exports of hundreds of MB, unzip and use **choose a folder**.

## Export

| What | Where | Formats |
|---|---|---|
| One page | Page **⋯ → Export** | **PDF / print** (choose "Save as PDF" in the print dialog), **Markdown (.md)** |
| A page and its subpages | Page **⋯ → With subpages…** | Markdown or HTML ZIP on the export page |
| A whole space | Space menu → **Export space…** | Markdown or HTML ZIP on the export page |

**The two ZIP formats:**
- **Markdown ZIP**: `.md` files in folders that follow the page tree, plus attachments.
- **HTML ZIP**: unzip it and open `index.html` in a browser. The page tree, links and images work without a server.

**Either way:**
- Both include a `pagehouse.json` that imports back into Pagehouse unchanged.
- Only pages you can see are included.
- A large space can take a few minutes, so keep the export page open.

## AI agents (MCP)

1. Create a token in **Your account → API tokens**.
2. Paste the command shown there into an MCP client such as Claude Code. Agents can then search, read, write and comment on pages.

Keep in mind:
- Agents act with **exactly your permissions**.
- The token is shown once. Treat it like a password and revoke it when unused.

## For administrators

**Admin** in the sidebar has seven tabs (Overview, People, Groups, SSO, Webhooks, Audit log, Branding).

**Overview:**
- **server health**: database response, memory, server delay, recent requests and server errors, live editing, waiting notifications, with warnings at the top ([monitoring](monitoring.md))
- storage use against the disk and an optional **storage limit**
- the last automatic backup, content counts, edits per day and the largest files
- the **backup policy**: how often to back up, how many backups to keep, and after how many days to delete old ones ([details](install.md#backup-and-restore))

At the limit new uploads are refused, but text always saves.

**People:**

| To | Do this |
|---|---|
| Invite | Create a **Member invite link** or **Admin invite link** and pass it on. It works once, within 7 days |
| Change a role | The role column |
| Block access | **Disable**: signs them out at once. **Enable** lets them back in |
| Reset a password | A **reset link** (once, within a day) or a **temporary password** (sign in right away; choose a new password at first sign-in). Both sign the person out everywhere |

**SSO:** let people sign in with a company account through an OpenID Connect provider (tested with Keycloak).
1. Register the **redirect URI** shown on the screen with the provider.
2. Enter the issuer URL, client ID and client secret, and click **Test connection**.
3. Click **Turn on SSO**. It applies as soon as it's saved, and the sign-in page gets the button.

This is also where you choose whether first sign-ins create accounts and whether password sign-in stays allowed. If the server's `.env` sets `OIDC_ISSUER`, that wins and the screen is read-only. Signing out of the wiki also signs out of the provider. Provider-side steps: [SSO guide](sso.md).

**Webhooks:** send page and comment events to another system (CI, a bot, a search index).
1. **Add webhook**: a name, the URL, all spaces or one, and the events (page created, edited, deleted, comment added).
2. Copy the **signing secret** shown once. Each request is a JSON `POST` with headers `X-Pagehouse-Event` and `X-Pagehouse-Signature: sha256=<HMAC-SHA256 of the body with the secret>`; check it on the receiving side.
3. **Send test** posts a `ping` event. The list shows the last delivery and its result.

Restricted pages are never sent. Edits are sent at most every 10 minutes per page. Failed deliveries are retried twice (after 5 and 30 seconds).

**Branding:** your organization's name, logo and color instead of Pagehouse's.
- The **name** is the browser tab title and appears on the sign-in screen, at the top of the sidebar, and in email subjects (`[Name] …`) and the sender name (unless `SMTP_FROM` is set). Leave it empty for the default.
- The **logo** (PNG, JPG, WebP or GIF, up to 512 KB) is shown on the sign-in screen and the sidebar and is also the favicon. A square image works best. **Use default** brings back the original. On the dark theme the logo sits on a light plate, so dark logos stay visible.
- The **accent color** is used for buttons, links and highlights; the dark theme uses a lighter shade of it. Buttons have white text, so the screen warns when the color is too light to read it (contrast under 4.5:1).
- Changes show at once for you; others see them the next time they open the wiki (allow up to 30 seconds). Each change is in the audit log.

**Groups:** group people, then grant space roles and page restrictions to the group. A group still used in permissions can't be deleted.

**Audit log:**
- What it records: sign-ins (failed ones too), account, group and permission changes, page deletions, restores and moves, exports, and API tokens.
- Filter by action. Permission changes record what changed.

You can't change your own role or disable yourself, so there is always at least one administrator.
