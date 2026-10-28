import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

/** The screen Claude sees. A laptop-sized web viewport, under the toolset's image limits without resizing. */
export const SCREEN = { width: 1280, height: 800 };

// One scroll_amount click, in pixels, about what a mouse wheel notch moves.
const WHEEL_PX = 100;
// Long waits are the agent stalling, and the person is waiting on a text.
const MAX_WAIT_S = 10;
// Lets a click's navigation or a form's re-render start before the next action or screenshot.
const SETTLE_MS = 400;

export type ComputerResult = { text: string } | { image: string };

/** xdotool-style key names Claude sends, to Playwright's. Single characters and F-keys pass through. */
const KEYS: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  kp_enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  page_up: "PageUp",
  pageup: "PageUp",
  page_down: "PageDown",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  shift: "Shift",
  super: "Meta",
  cmd: "Meta",
  meta: "Meta",
};

function keyName(part: string): string {
  return KEYS[part.toLowerCase()] ?? (part.length === 1 ? part : part.charAt(0).toUpperCase() + part.slice(1));
}

/** "ctrl+shift+a" to "Control+Shift+a". */
function chord(text: string): string {
  return text.split("+").map((part) => keyName(part.trim())).join("+");
}

function point(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value.map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.max(0, Math.min(SCREEN.width - 1, x!)), Math.max(0, Math.min(SCREEN.height - 1, y!))];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A Browserbase Chrome driven only through Claude's computer use toolset: screenshots, mouse, and keyboard,
 * the way a person would. There's no address bar on screen, so the agent gets around by clicking, and
 * `allowed` is enforced in the browser on every page load, popups and redirects included.
 */
export class Computer {
  private cursor: [number, number] = [0, 0];
  private shots = 0;
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private page: Page,
  ) {
    // A link that opens a new tab is where they'd look next, so it becomes the screen.
    context.on("page", (opened) => {
      this.page = opened;
      opened.on("close", () => {
        if (this.page === opened) this.page = context.pages().at(-1) ?? opened;
      });
    });
  }

  static async open(input: { apiKey: string; projectId?: string; allowed: (url: string) => boolean }): Promise<Computer> {
    const bb = new Browserbase({ apiKey: input.apiKey });
    const session = await bb.sessions.create({
      ...(input.projectId ? { projectId: input.projectId } : {}),
      browserSettings: { viewport: SCREEN, solveCaptchas: true },
      // Residential IPs, so checkouts with fraud checks (DICE) don't refuse a datacenter browser.
      // Billed per GB on Browserbase plans that include proxies, so it's switched on in the env.
      ...(process.env.BROWSERBASE_PROXIES === "true" ? { proxies: true } : {}),
    });
    const browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: SCREEN }));
    // Page loads off the allowed sites are refused before any request leaves. Images, scripts, and
    // APIs on other hosts still load, since real pages need their CDNs.
    await context.route("**/*", (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === request.frame().page().mainFrame() && !input.allowed(request.url())) {
        console.warn(`[rsvp] blocked a page load off the allowed sites: ${new URL(request.url()).hostname}`);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(SCREEN);
    return new Computer(browser, context, page);
  }

  /** Where the screen is now. Haps's own code reads this; the agent only sees screenshots. */
  url(): string {
    return this.page.url();
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await this.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  }

  async screenshot(): Promise<string> {
    const png = await this.page.screenshot({ type: "png", scale: "css", timeout: 10_000 });
    // Dry runs only (npm run rsvp): keep what the agent saw, to debug a site it gave up on.
    if (process.env.RSVP_SCREENSHOT_DIR) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(`${process.env.RSVP_SCREENSHOT_DIR}/${String(++this.shots).padStart(2, "0")}.png`, png).catch(() => {});
    }
    return png.toString("base64");
  }

  /** Runs one computer member. Throws with a line Claude can act on when the input is wrong. */
  async run(name: string, input: Record<string, unknown>): Promise<ComputerResult> {
    const mouse = this.page.mouse;
    const text = typeof input.text === "string" ? input.text : undefined;
    const withModifiers = async (action: () => Promise<void>) => {
      const held = text ? text.split("+").map((part) => keyName(part.trim())) : [];
      for (const key of held) await this.page.keyboard.down(key);
      try {
        await action();
      } finally {
        for (const key of held.reverse()) await this.page.keyboard.up(key);
      }
    };
    const at = (field = "coordinate") => {
      const p = input[field] === undefined ? this.cursor : point(input[field]);
      if (!p) throw new Error(`${field} must be [x, y] inside the ${SCREEN.width}x${SCREEN.height} screen`);
      this.cursor = p;
      return p;
    };

    switch (name) {
      case "screenshot":
        return { image: await this.screenshot() };
      case "zoom": {
        const region = Array.isArray(input.region) ? input.region.map(Number) : [];
        const [x0, y0, x1, y1] = region;
        if (region.length !== 4 || !region.every(Number.isFinite) || x1! <= x0! || y1! <= y0!) {
          throw new Error("region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0");
        }
        const clip = { x: Math.max(0, x0!), y: Math.max(0, y0!), width: Math.min(SCREEN.width, x1!) - Math.max(0, x0!), height: Math.min(SCREEN.height, y1!) - Math.max(0, y0!) };
        const png = await this.page.screenshot({ type: "png", scale: "device", clip, timeout: 10_000 });
        return { image: png.toString("base64") };
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        const [x, y] = at();
        const button = name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left";
        const clickCount = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
        await withModifiers(() => mouse.click(x, y, { button, clickCount }));
        await sleep(SETTLE_MS);
        return { text: "OK" };
      }
      case "left_click_drag": {
        const [sx, sy] = at("start_coordinate");
        const [ex, ey] = at();
        await withModifiers(async () => {
          await mouse.move(sx, sy);
          await mouse.down();
          await mouse.move(ex, ey, { steps: 12 });
          await mouse.up();
        });
        return { text: "OK" };
      }
      case "mouse_move": {
        const [x, y] = at();
        await mouse.move(x, y);
        return { text: "OK" };
      }
      case "left_mouse_down":
        await mouse.down();
        return { text: "OK" };
      case "left_mouse_up":
        await mouse.up();
        await sleep(SETTLE_MS);
        return { text: "OK" };
      case "cursor_position":
        return { text: `X=${this.cursor[0]}, Y=${this.cursor[1]}` };
      case "scroll": {
        const [x, y] = at();
        const amount = Math.max(1, Math.min(20, Number(input.scroll_amount) || 3)) * WHEEL_PX;
        const direction = String(input.scroll_direction);
        const [dx, dy] = direction === "up" ? [0, -amount] : direction === "down" ? [0, amount] : direction === "left" ? [-amount, 0] : direction === "right" ? [amount, 0] : [NaN, NaN];
        if (!Number.isFinite(dx)) throw new Error("scroll_direction must be up, down, left, or right");
        await mouse.move(x, y);
        await withModifiers(() => mouse.wheel(dx!, dy!));
        await sleep(SETTLE_MS);
        return { text: "OK" };
      }
      case "type":
        if (text === undefined) throw new Error("type needs text");
        await this.page.keyboard.type(text, { delay: 15 });
        return { text: "OK" };
      case "key": {
        if (!text) throw new Error("key needs text, like Return or ctrl+a");
        const repeat = Math.max(1, Math.min(100, Number(input.repeat) || 1));
        for (let i = 0; i < repeat; i += 1) await this.page.keyboard.press(chord(text));
        await sleep(SETTLE_MS);
        return { text: "OK" };
      }
      case "hold_key": {
        if (!text) throw new Error("hold_key needs text");
        const keys = chord(text).split("+");
        for (const key of keys) await this.page.keyboard.down(key);
        await sleep(Math.min(MAX_WAIT_S, Math.max(0, Number(input.duration) || 0)) * 1000);
        for (const key of keys.reverse()) await this.page.keyboard.up(key);
        return { text: "OK" };
      }
      case "wait":
        await sleep(Math.min(MAX_WAIT_S, Math.max(0, Number(input.duration) || 1)) * 1000);
        return { text: "OK" };
      default:
        throw new Error(`${name} isn't available here`);
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close();
  }
}
