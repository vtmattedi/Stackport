# Stackport 1.3.10

Started 11 November 2026, from 1.3.9. A UI and UX release: no server behaviour changes except three messages that now point to the right page.

## Decided

- **Text and controls are spaced by components, not by luck.** The global reset gives every element a zero margin, and nothing put spacing back, so
  paragraphs, hints, fields and buttons touched. New shared pieces: `Stack` (spacing), `Prose` and `Hint` (running text, 75 characters wide, hints at
  12 px), `Field` and `CheckRow` (a label, its control, what to say about it), `Checkbox`, `RadioGroup`, `Textarea`, `Disclosure` (what `<details>` was used
  for), and `Combobox` (a select you can type into, for lists too long to scroll). Checkbox and radio borders use the dimmed text colour: the input
  border colour is almost the background colour, and the boxes could not be seen.
- **Pages that were long put the action first and fold the reference.** MCP: the create-token form is at the top, tokens are rows that read at any
  width (the table clipped at 390 px), and the 16-tool list is one line until opened. Networks: the owner is one line and the pool how-to opens by itself
  only when the pool is filling up. Notifications: the push events sit in two columns on wide screens.
- **Settings > GitHub is a page, not a paragraph.** An App header (name, visibility, modules as badges), an Accounts card whose primary button is the next
  step (Install when nothing is installed, Connect when an account is not connected), Recent deliveries, and the rare actions folded away.
- **The Stackport address moves to Settings > Domains.** The hostname Nginx serves Stackport on, HTTPS and its certificate were on Host > Nginx, while the GitHub page
  sent people to "Settings > General", which has no such field. They are now the first card of Settings > Domains, and the three messages that mention it
  say so.
- **Host is a router and six sections** (`System.tsx` held four pages in 1273 lines).
  - **Nginx:** the published routes first; the state of the last apply in one line ("not applied yet", not FAILED, when nothing was applied); paths and the template
    editor folded.
  - **Certbot:** one row per hostname, most urgent first; Renew is the primary button when a certificate needs a hand, Issue when there is none; deleting a certificate asks first
    (it did not); the email form is a notice only while no email is set. Certificates are issued when a hostname is routed and renewed in the background, and the page says so.
  - **Docker:** Stackport's projects (stacks named `<id>-<slug>`) first, linking to the project instead of repeating its Compose buttons; other stacks keep Up, Down and Build;
    every stack starts collapsed; disk use, storage pressure and the repo scan are their own tab.
- **The new-project wizard lists the repositories the GitHub App can use.** The Source stage has three cards: GitHub repository (the App, the starting choice when it is set up),
  GitHub link or token, Upload files. The App's repositories are a searchable list grouped by account, with private marks and whether one is already a project. Picking one reads its default
  branch from GitHub (the existing `/inspect` endpoint) and says which Compose files it has and how many variables its `.env.example` lists, or that it has no Compose file, before anything is cloned.
- **Projects names what needs attention, and an empty list is a first-run checklist.** A strip above the list names every project that is down or whose health check fails. With no
  projects the page shows the base domain (needed) and the GitHub App (optional), whether each is done, and the button to add the first project.
- **No home page.** Insights > Overview already has the tiles and "Needs attention"; a home page would repeat it.

## Found by looking

- A popover opened from inside a modal sat under the modal's backdrop, so a searchable select in the wizard could be seen but not clicked. Popovers now have the z-index selects have.

## Tooling

- `npm run ui:shots` can click through to a dialog or a tab: `--pages "projects>Add new project>=Repository"` (each `>` clicks a button, link, tab, radio, combobox or option; `=Name` for the whole name), reports a
  failing request by its address, and no longer answers 429 on a long run.
- The harness has a fake Docker (`scripts/ui/fakeDocker.ts`: stacks, a running Nginx, certificates that are valid, expiring, expired and missing, networks), a seeded GitHub App, and switches for the
  empty states: `UI_HARNESS_GITHUB=none`, `UI_HARNESS_PROJECTS=none`, `UI_HARNESS_DOCKER=real`.

## Not verified

- **Against a real server.** Host > Nginx, Docker and Certbot were looked at only through the fake Docker. Host > Certbot's Issue, Renew and Delete, the Stackport address's Save and certificate buttons, and Nginx's Apply and the template editor
  are the same calls as before in new places; none were run against a real Nginx, certbot or GitHub.
- **The wizard's Configure and Deploy stages.** They were not redone: they need a clone, which the harness cannot do. Only their container (the wizard) and the Source stage changed. The repository list and its inspection were seen with a stand-in for
  GitHub's answer; against github.com they are the existing endpoints (tested in tests/githubAppProjects.test.ts with GitHub stubbed), and that call has not been made against github.com.
- **The wizard is still a dialog**, not a page. Its Continue still creates the project, which the resume-setup path depends on.
- The native file chooser in the upload path, `NginxCode` and the env editor keep their own styling.

## Planned, not built

- Redo the wizard's Configure stage (branch, Compose file, hostname, port, SSL) so it shows only what needs a decision.
- Bring Hardware, Credentials and Insights through the same spacing pass the other pages had.
