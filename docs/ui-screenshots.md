# Looking at the UI from the command line

`npm run ui:shots` starts a real Stackport on a throwaway database (the Express app, Socket.IO and the built client, with some
seeded projects, domains and tokens), logs in with a real browser (Playwright, Chromium) and takes full-page screenshots. For each
page and width it also reports whether the page **scrolls sideways** (it does not fit the screen) and anything written to the
browser console. Nothing needs Docker; what asks Docker shows its empty or error state.

```
npm --prefix client run build:dry                   # the harness serves client/dist
npx playwright install chromium                     # once
npm run ui:shots                                    # every default page at 1440, 1024 and 390 px, into ui-shots/
npm run ui:shots -- --pages settings/mcp --widths 1440,390
npm run ui:shots -- --url http://localhost:3000 --user admin --password ...   # an instance that is already running
```

- A page can be followed by clicks, each after a `>`: `--pages "projects>Add new project>The GitHub App"` opens the new-project wizard and picks the
  GitHub App. A click finds a button, link or radio by its name.
- The harness seeds a registered GitHub App with two connected accounts and ten repositories (no network is used), and resets the global
  rate limit every second so a long run is not answered with 429.
- Write pages without the leading slash on Windows with Git Bash, which rewrites `/settings/mcp` into a path on disk.
- `ui-shots/` is ignored by git. A page that has a `!` in front of it in the output has a problem worth opening.
- The data comes from `scripts/ui/harness.ts`; add what a page needs to show there.
