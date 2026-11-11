import fs from "fs";
import path from "path";
import { chromium, type ConsoleMessage } from "playwright";
import { HARNESS_PASSWORD, HARNESS_USER, startHarness } from "./harness";

/**
 * Screenshots of Stackport's pages at several widths, from a real browser, plus what a person would not see in a screenshot:
 * whether a page scrolls sideways (does not fit the screen) and what it wrote to the console.
 *
 *   npm run ui:shots                                  every default page at 1440, 1024 and 390 px
 *   npm run ui:shots -- --pages /settings/mcp          only these (comma separated)
 *   npm run ui:shots -- --pages "projects>Add new project>The GitHub App"   click through: each `>` clicks the button, link, tab, radio, combobox or option whose name contains that text (`=Name` for the whole name)
 *   npm run ui:shots -- --widths 1280 --out some/dir   other widths, other folder (default: ui-shots/)
 *   npm run ui:shots -- --wait 5000                    wait longer for slow pages (default 1200 ms after load)
 *   npm run ui:shots -- --url http://localhost:3000    an already running Stackport (logs in with --user and --password)
 *
 * It needs the built client: `npm --prefix client run build:dry`.
 */

const DEFAULT_PAGES = [
  "/projects", "/projects>Add new project", "/projects/1/domains", "/projects/1/settings", "/logs",
  "/host/hardware", "/host/docker", "/host/networks", "/host/nginx", "/host/certbot", "/host/power",
  "/insights/overview", "/settings/general", "/settings/notifications", "/settings/deploy-triggers", "/settings/domains", "/settings/protections",
  "/settings/github", "/settings/credentials", "/settings/mcp", "/settings/encryption",
];

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const slug = (page: string): string => page.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/g, "") || "home";

/** `projects>Add new project` is the page /projects after clicking the button or link called "Add new project"; more `>` click on. */
function splitTarget(target: string): { path: string; clicks: string[] } {
  const [path, ...clicks] = target.split(">").map((part) => part.trim());
  return { path, clicks };
}

async function main(): Promise<void> {
  // A leading slash is optional: Git Bash on Windows rewrites "/settings/mcp" into a path on disk, so "settings/mcp" is the safe spelling there.
  const pages = (option("pages") ?? DEFAULT_PAGES.join(",")).split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`));
  const widths = (option("widths") ?? "1440,1024,390").split(",").map((w) => Number(w.trim())).filter((w) => w > 0);
  const out = path.resolve(option("out") ?? "ui-shots");
  const wait = Number(option("wait") ?? 1200);
  const user = option("user") ?? HARNESS_USER;
  const password = option("password") ?? HARNESS_PASSWORD;

  const external = option("url");
  if (!external && !fs.existsSync(path.resolve("client/dist/index.html"))) {
    console.error("client/dist is missing. Build it first: npm --prefix client run build:dry");
    process.exit(2);
  }
  const harness = external ? null : await startHarness();
  const base = external ?? harness!.url;
  fs.mkdirSync(out, { recursive: true });

  const browser = await chromium.launch();
  let wide = 0;
  try {
    const context = await browser.newContext({ viewport: { width: widths[0], height: 900 } });
    // What github.com would answer (the harness has no network): the wizard looks inside a repository before cloning it.
    if (!external) {
      await context.route("**/api/github-app/repositories/*/inspect**", (route) => route.fulfill({ json: { composeFiles: ["docker-compose.yml", "deploy/compose.prod.yml"], envVariableNames: ["DATABASE_URL", "SECRET_KEY", "PORT"], truncated: false } }));
    }
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    page.on("console", (msg: ConsoleMessage) => {
      // A failed request is reported once, with its address, by the response handler below; the console line for it says nothing more.
      if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) problems.push(`console: ${msg.text()}`);
    });
    page.on("response", (response) => { if (response.status() >= 400) problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });

    await page.goto(base);
    try {
      await page.locator("input[autocomplete=username]").fill(user, { timeout: 10_000 });
      await page.locator("input[autocomplete=current-password]").fill(password);
      await page.locator("button[type=submit]").click();
      await page.waitForURL((url) => url.pathname !== "/", { timeout: 15_000 });
    } catch (err) {
      const file = path.join(out, "login-failed.png");
      await page.screenshot({ path: file, fullPage: true });
      throw new Error(`Could not log in (${err instanceof Error ? err.message.split(String.fromCharCode(10))[0] : "unknown"}). What the page showed is in ${file}. ${problems.join(" | ")}`);
    }

    for (const target of pages) {
      for (const width of widths) {
        problems.length = 0;
        await page.setViewportSize({ width, height: 900 });
        const { path: route, clicks } = splitTarget(target);
        await page.goto(`${base}${route}`, { waitUntil: "load" });
        await page.waitForTimeout(wait); // data arrives over the socket and fetches after load
        for (const click of clicks) {
          // A leading = asks for the whole name; without it any name that contains the text matches.
          const exact = click.startsWith("=");
          const name = exact ? click.slice(1) : click;
          const opts = { name, exact };
          await page.getByRole("button", opts).or(page.getByRole("link", opts)).or(page.getByRole("radio", opts)).or(page.getByRole("tab", opts)).or(page.getByRole("combobox", opts)).or(page.getByRole("option", opts)).first().click({ timeout: 5_000 });
          await page.waitForTimeout(600);
        }
        const file = path.join(out, `${slug(target)}-${width}.png`);
        await page.screenshot({ path: file, fullPage: true });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) wide += 1;
        const notes = [overflow > 1 ? `scrolls sideways by ${overflow}px` : "", ...problems.slice(0, 3)].filter(Boolean);
        console.log(`${notes.length ? "!" : " "} ${target} @ ${width}${notes.length ? `  ${notes.join(" | ")}` : ""}`);
      }
    }
    console.log(`\nScreenshots are in ${out}${wide ? `; ${wide} page/width combination(s) scroll sideways` : ""}.`);
  } finally {
    await browser.close();
    if (harness) await harness.stop();
  }
}

main().then(() => process.exit(0), (err: unknown) => { console.error(err); process.exit(1); });
