# User guide

[한국어](user-guide.ko.md)

## Signing in

- Open the invite link an administrator sent you and create your account.
- Forgot your password? Ask an administrator for a reset link. It works once within a day.
- Change your password and the interface language under **your name** (bottom left) → **Your account**. The language and the theme (system, light or dark; also the sun/moon button next to your name) are saved to your account, so they follow you to every device. Before signing in you can pick it at the bottom of the sign-in screen.

## Home

After signing in you land on **Home**:

- **Recently viewed**: the pages you opened last.
- **For you**: where someone mentioned you, replied to your comment, or commented on a page you created.
- **New pages**: what was created recently, in spaces you can see.
- Buttons at the top start a page from a template or open **Import**.

The bell next to the space name shows unread notifications; click one to open the page.

## Spaces and pages

A **space** is a top-level area, usually one per team. Pages inside a space form a tree.

| To | Do this |
|---|---|
| Switch space or create one | Click the space name at the top left |
| Change who can see a space | Space name → **Space settings** (space admins) |
| Create a page | **New page** in the sidebar, or a template on **Home** |
| Create a page inside another | Hover a page in the sidebar and click **+** |
| Move or reorder a page | Drag it in the sidebar. Drop on the middle of a page to put it inside, near the top or bottom edge to place it before or after |
| Delete a page | **⋯ → Move to trash**. Pages inside it go too. **Undo** appears for a few seconds |
| Restore a page | **Trash** in the sidebar → **Restore** |

### Templates

**Home** offers four starting points: Blank page, Weekly report, Meeting notes and Technical doc. The template content is ordinary page content, so edit it freely.

## Writing

Pages **save automatically** about a second after you stop typing. The top bar shows *Saving…* and then *Saved*. Press **⌘S** / **Ctrl+S** to save right away.

### Blocks: type `/`

Type `/` on an empty line to insert a block, then keep typing to filter (`/table`, `/code`, `/표` all work).

| Block | Notes |
|---|---|
| Headings 1–3 | They feed the **Contents** list on the right |
| Bulleted, numbered and to-do lists | Tab / Shift+Tab to indent |
| Table | Click inside a table for a menu: add or delete rows and columns, header row. To merge, drag across cells (or Shift-click) and choose **Merge cells**; in a merged cell, **Split cell** |
| Info / Warning / Success / Danger panel | Click the panel icon to change its type |
| Code block | Pick the language from the menu that appears above it |
| Quote, divider | |
| Image or file | Or paste or drag files straight into the page |

### Formatting

Select text to open the formatting menu: bold, italic, strikethrough, inline code, highlight, link, heading.

Markdown-style shortcuts also work as you type:

| Type | Get |
|---|---|
| `# ` `## ` `### ` | Heading |
| `- ` or `* ` | Bulleted list |
| `1. ` | Numbered list |
| `[ ] ` | To-do item |
| `> ` | Quote |
| `` ``` `` | Code block |
| `---` | Divider |

| Shortcut | Action |
|---|---|
| ⌘K / Ctrl+K | Search |
| ⌘S / Ctrl+S | Save now |
| ⌘B, ⌘I | Bold, italic |
| Enter in the title | Jump to the body |
| ⌘Enter in a comment | Post it |

### Images and files

Paste, drag in, or use `/` → **Image or file**. PNG, JPEG, GIF and WebP images show in the page. Other files appear as a link that downloads. Up to 50 MB per file.

## When two people edit the same page

Whoever saves first wins. The other person sees *Someone else changed this page* and autosave pauses, so nothing is overwritten. Their edits stay on their device: after **Reload**, a bar offers **Restore them**, which applies the edits on top and keeps the other person's version in History. Real-time co-editing is planned.

## If the connection drops

Edits that haven't reached the server are kept in your browser. The top bar says *Offline*, and saving resumes by itself when the connection is back. If you close the tab first, the next time you open the page a bar offers to restore them.

Deleted comments can be brought back with **Undo** right after deleting, like pages.

## History

**History** in the top bar lists earlier versions. Saves by the same person within 10 minutes are grouped into one version. **Restore this version** brings it back; the current content stays in the history.

## Comments

Comments sit at the bottom of each page. Reply under a comment, and mark it **Resolve** when it is done. Resolved comments are hidden until you show them.

## Mentions and notifications

Type `@` in a page or a comment and pick a person. They get a notification once the page is saved or the comment posted, but only if they can open that page. You also get notified when someone replies to your comment or comments on a page you created.

## Who can see a space

Every space has a default for people who aren't members:

| Setting | Meaning |
|---|---|
| Everyone can edit | Everyone signed in can view and edit (the default) |
| Everyone can view | Everyone can read; only members with **Can edit** or **Admin** can change pages |
| Private | Only members can see the space. It doesn't appear in the space list, search or home for anyone else |

Members get **Admin** (manage the space), **Can edit** or **Can view**. Whoever creates a space becomes its admin. A page can never be more open than its space: in a view-only space, page restrictions can narrow access further but not widen it.

## Who can see a page

By default everyone signed in can view and edit every page. To limit a page:

1. Click **Access** in the top bar.
2. Choose **Only selected people**.
3. Add people and give each **Can view** or **Can edit**.

Rules:

- People not listed cannot find the page anywhere: not in the sidebar, search, recent pages, trash, comments, history or attachments.
- Pages **inside** a restricted page inherit the restriction. To see a page you must be allowed on every restricted page above it.
- You always keep edit access to a page you restrict.
- **Administrators can open every page**, so they can fix a page nobody can open.
- Restricted pages show a lock in the sidebar and in the top bar.

## Search

Press **⌘K** / **Ctrl+K** or click **Search** for quick search: the best matches as you type. **Enter** opens the highlighted page; **⌘Enter** (or **See all results**) opens the search page.

The search page finds pages that contain **every** word you type, title matches first, and shows each result's location and the matching text. Narrow it down with:

| Filter | Options |
|---|---|
| Space | One space or all |
| Last edited by | Any person |
| Updated | Past week, month, year |
| Search in | Titles and text, or titles only |
| Sort | Most relevant or most recent |

The address bar keeps the search and filters, so you can bookmark a search or send the link to someone. Results only include pages you are allowed to see.

## Import and export

**Import** (Home, the space menu, or a page's **⋯ → Import into this page**) accepts Markdown, HTML and text files, or a ZIP of them:

- a Pagehouse export: restored exactly, with the page tree, attachments and links;
- a Notion "Markdown & CSV" export: folders become subpages, images are uploaded;
- a Confluence "HTML" space export: the page tree is rebuilt from breadcrumbs, attachments are uploaded, info and warning macros become panels.

Import only adds new pages; it never changes existing ones.

**Export**: a page's **⋯ → Export page and subpages (.zip)**, or the space menu's **Export space (.zip)**, downloads Markdown files in folders that mirror the page tree, with the attachments and a `pagehouse.json` for lossless re-import. Only pages you can see are included. **⋯ → Export as Markdown** saves a single page; **⋯ → Print / save as PDF** opens the print dialog.

## For administrators

**Admin** in the sidebar has two tabs.

**Overview**: storage used (database and attachments) against the disk and an optional **storage limit**, the last automatic backup, content counts, edits per day and the largest files. When the limit is reached, new uploads are refused but text edits always save.

**People**:

| Task | How |
|---|---|
| Invite someone | **Member invite link** or **Admin invite link**, then send the link. It works once within 7 days |
| Change a role | Role column |
| Lock someone out | **Disable**. They are signed out immediately. **Enable** lets them back in |
| Reset a password | **Reset password link**, send it to them. It works once within a day |

You cannot change your own role or disable yourself, so a site always keeps at least one administrator.
