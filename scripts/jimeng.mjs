#!/usr/bin/env node
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const DEFAULT_HOME_URL = "https://jimeng.jianying.com/ai-tool/home";
const DEFAULT_SELECTOR_VERSION = "jimeng-skill-20260419-v1";
const LOGIN_BODY_TEXT = [/请先登录/, /前往登录/, /同意.*登录/, /手机号登录/, /验证码/, /扫码登录/];
const LOGIN_CONTROL_TEXT = [/^登录$/, /手机号登录/, /验证码/, /扫码登录/, /前往登录/];
const DOWNLOAD_TEXT = [/下载/, /保存/, /导出/];
const QUEUE_TEXT = [/排队加速中/, /正在排队/, /排队中/, /预计剩余/];

export class JimengClient {
  constructor(options = {}) {
    this.stateDir = options.stateDir ?? defaultStateDir();
    this.homeUrl = options.homeUrl ?? DEFAULT_HOME_URL;
    this.browserChannel = options.browserChannel === undefined ? "chrome" : options.browserChannel;
    this.selectorVersion = options.selectorVersion ?? DEFAULT_SELECTOR_VERSION;
  }

  resolveAccount(accountId, overrides = {}) {
    const profileDir = overrides.profileDir ?? path.join(this.stateDir, "accounts", accountId, "profile");
    return { id: accountId, profileDir };
  }

  async login(options) {
    const account = this.resolveAccount(options.accountId, options);
    const context = await this.launchContext(account, { headless: false });
    try {
      const page = await context.newPage();
      await page.goto(options.homeUrl ?? this.homeUrl, { waitUntil: "domcontentloaded", timeout: options.navTimeoutMs ?? 60_000 });
      const timeoutMs = options.timeoutMs ?? 10 * 60_000;
      const startedAt = Date.now();
      let readyChecks = 0;
      while (Date.now() - startedAt < timeoutMs) {
        await page.waitForTimeout(2_000);
        await this.dismissBlockingDialogs(page);
        if (!(await this.needsLogin(page))) {
          readyChecks += 1;
          if (readyChecks >= 3) {
            return {
              status: "ready",
              account_id: account.id,
              profile_dir: account.profileDir,
              url: page.url(),
            };
          }
        } else {
          readyChecks = 0;
        }
      }
      return {
        status: "timeout",
        account_id: account.id,
        profile_dir: account.profileDir,
        message: "Timed out waiting for JiMeng login confirmation.",
        url: page.url(),
      };
    } finally {
      await context.close();
    }
  }

  async checkSession(options) {
    const account = this.resolveAccount(options.accountId, options);
    const context = await this.launchContext(account, { headless: options.headless ?? true });
    try {
      const page = await context.newPage();
      await page.goto(options.homeUrl ?? this.homeUrl, { waitUntil: "domcontentloaded", timeout: options.navTimeoutMs ?? 60_000 });
      await page.waitForTimeout(options.settleMs ?? 1_500);
      await this.dismissBlockingDialogs(page);
      const needsLogin = await this.needsLogin(page);
      return {
        status: needsLogin ? "needs_login" : "ready",
        account_id: account.id,
        profile_dir: account.profileDir,
        needs_login: needsLogin,
        url: page.url(),
      };
    } finally {
      await context.close();
    }
  }

  async generate(options) {
    const account = this.resolveAccount(options.accountId, options);
    const artifactDir = options.artifactDir ?? path.join(this.stateDir, "runs", buildRunId(), "artifacts");
    await ensureDir(artifactDir);

    const context = await this.launchContext(account, { headless: !(options.headed ?? false) });
    try {
      const page = await context.newPage();
      const mode = normalizeMode(options.mode, options.kind);
      const workspaceUrl = resolveWorkspaceUrl(options.homeUrl ?? this.homeUrl, mode);
      await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: options.navTimeoutMs ?? 60_000 });
      await page.waitForTimeout(options.settleMs ?? 1_500);
      await this.dismissBlockingDialogs(page);

      if (await this.needsLogin(page)) {
        return this.waitingHuman(page, {
          reason: "login_required",
          message: `JiMeng account ${account.id} requires login.`,
          account,
          artifactDir,
          outputPath: options.outputPath,
          prompt: options.prompt,
          referencePaths: options.referencePaths ?? [],
          mode,
        });
      }

      await this.dismissBlockingDialogs(page);
      if (mode === "agent_reference_video") {
        await this.ensureAgentVideoSurface(page);
      } else {
        await this.waitForWorkspaceSurface(page, mode, workspaceUrl);
      }
      await this.dismissBlockingDialogs(page);

      await this.fillPrompt(page, options.prompt);
      await this.uploadReferences(page, options.referencePaths ?? []);
      if (mode === "agent_reference_video") {
        await this.configureAgentVideoSettings(page, { durationSec: options.durationSec, aspectRatio: options.aspectRatio });
      } else {
        if (options.durationSec) {
          await this.selectDuration(page, options.durationSec);
        }
        if (options.aspectRatio) {
          await this.selectAspectRatio(page, options.aspectRatio);
        }
      }
      await this.dismissBlockingDialogs(page);

      const trigger = await this.waitForGenerateTrigger(page);
      if (!trigger) {
        return this.waitingHuman(page, {
          reason: "selector_drift_generate_trigger",
          message: "Could not locate a JiMeng generate button.",
          account,
          artifactDir,
          outputPath: options.outputPath,
          prompt: options.prompt,
          referencePaths: options.referencePaths ?? [],
          mode,
        });
      }

      const preGenerationMediaUrls = await this.collectMediaUrls(page, options.kind);
      await trigger.click();
      const result = await this.waitForDownload(page, {
        outputPath: options.outputPath,
        expectedKind: options.kind,
        timeoutMs: options.timeoutMs ?? 180_000,
        artifactDir,
        ignoredMediaUrls: preGenerationMediaUrls,
      });

      if (!result) {
        return this.waitingHuman(page, {
          reason: "download_not_available",
          message: "JiMeng generation finished without an accessible download action.",
          account,
          artifactDir,
          outputPath: options.outputPath,
          prompt: options.prompt,
          referencePaths: options.referencePaths ?? [],
          mode,
        });
      }

      if (result.status === "queued") {
        return this.waitingHuman(page, {
          reason: "provider_queue_wait",
          message: buildQueueWaitMessage(result.queueState),
          account,
          artifactDir,
          outputPath: options.outputPath,
          prompt: options.prompt,
          referencePaths: options.referencePaths ?? [],
          mode,
          extraArtifacts: [result.artifactPath],
          details: {
            queue_state: result.queueState,
            queue_artifact_path: result.artifactPath,
          },
          checklist: [
            "Treat JiMeng queueing as a normal pause point, not as a provider failure.",
            "Do not immediately rerun generation, or the same asset may be re-queued from scratch.",
            "Wait for the queued result to finish or reopen JiMeng history with this profile later.",
            "Download the finished asset into the expected output path recorded in this file.",
          ],
        });
      }

      const successShot = path.join(artifactDir, "success.png");
      await page.screenshot({ path: successShot, fullPage: true }).catch(() => undefined);
      return {
        status: "success",
        account_id: account.id,
        profile_dir: account.profileDir,
        output_path: options.outputPath,
        artifact_dir: artifactDir,
        artifact_paths: [result.artifactPath, successShot].filter(Boolean),
        download_url: result.downloadUrl,
        selector_version: this.selectorVersion,
      };
    } catch (error) {
      const page = context.pages()[0];
      return this.waitingHuman(page, {
        reason: "automation_exception",
        message: error instanceof Error ? error.message : String(error),
        account,
        artifactDir,
        outputPath: options.outputPath,
        prompt: options.prompt,
        referencePaths: options.referencePaths ?? [],
        mode: normalizeMode(options.mode, options.kind),
      });
    } finally {
      await context.close();
    }
  }

  async launchContext(account, options) {
    await ensureAccountProfile(account);
    await cleanupChromeSingletonArtifacts(account.profileDir);
    const launchOptions = {
      headless: options.headless,
      acceptDownloads: true,
      downloadsPath: path.join(account.profileDir, "downloads"),
      viewport: { width: 1440, height: 960 },
    };
    if (this.browserChannel) {
      launchOptions.channel = this.browserChannel;
    }
    return chromium.launchPersistentContext(account.profileDir, launchOptions);
  }

  async needsLogin(page) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (!bodyText.trim()) {
      return true;
    }
    const normalizedBody = bodyText.replace(/\r\n/g, "\n");
    if (/(^|\n)\s*登录\s*(\n|$)/.test(normalizedBody)) {
      return true;
    }
    if (LOGIN_BODY_TEXT.some((pattern) => pattern.test(bodyText))) {
      return true;
    }
    const controls = page.locator("button, a, [role='button'], [role='link'], div");
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) {
        continue;
      }
      const text = await control.innerText().catch(() => "");
      if (text.trim() && LOGIN_CONTROL_TEXT.some((pattern) => pattern.test(text))) {
        return true;
      }
    }
    return false;
  }

  async fillPrompt(page, prompt) {
    const candidates = [
      page.locator("[contenteditable='true'][role='textbox']").first(),
      page.locator("[contenteditable='true']").first(),
      page.locator("textarea").filter({ hasNot: page.locator("[disabled]") }).first(),
      page.locator("textarea").first(),
      page.locator("input[placeholder]").filter({ hasNot: page.locator("[type='file']") }).first(),
    ];
    for (const locator of candidates) {
      if ((await locator.count().catch(() => 0)) === 0) {
        continue;
      }
      if (!(await locator.isVisible().catch(() => false))) {
        continue;
      }
      await locator.fill(prompt);
      return;
    }
    throw new Error("JiMeng prompt input was not found.");
  }

  async uploadReferences(page, referencePaths) {
    if (referencePaths.length === 0) {
      return;
    }
    const fileInput = page.locator("input[type='file']").last();
    if ((await fileInput.count().catch(() => 0)) === 0) {
      return;
    }
    const allowsMultiple = (await fileInput.getAttribute("multiple").catch(() => null)) !== null;
    await fileInput.setInputFiles(allowsMultiple ? referencePaths : [referencePaths[0]]);
    await page.waitForTimeout(1_000);
  }

  async waitForWorkspaceSurface(page, mode, beforeUrl) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const hasPrompt =
        (await page.locator("[contenteditable='true'][role='textbox']").first().isVisible().catch(() => false)) ||
        (await page.locator("textarea").filter({ hasNot: page.locator("[disabled]") }).first().isVisible().catch(() => false));
      const hasFileInput = mode === "image_to_video" ? (await page.locator("input[type='file']").count().catch(() => 0)) > 0 : false;
      const hasSubmit = await this.hasVisibleLocator(page.locator("button[class*='submit-button-'], button.lv-btn-primary"));
      if (page.url() !== beforeUrl || hasPrompt || hasFileInput || hasSubmit) {
        return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  async ensureAgentVideoSurface(page) {
    const combobox = page.locator("[role='combobox']").filter({ hasText: /Agent 模式/ }).last();
    if ((await combobox.count().catch(() => 0)) === 0 || !(await combobox.isVisible().catch(() => false))) {
      throw new Error("JiMeng Agent mode combobox was not found.");
    }
  }

  async configureAgentVideoSettings(page, options) {
    const autoButton = page.locator("button").filter({ hasText: /^自动$/ }).last();
    if ((await autoButton.count().catch(() => 0)) > 0 && (await autoButton.isVisible().catch(() => false))) {
      await autoButton.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
    if (options.aspectRatio) {
      const aspectOption = await this.findVisibleRadioOption(page, new RegExp(`^${escapeRegExp(options.aspectRatio)}$`, "i"));
      if (aspectOption) {
        await aspectOption.click().catch(() => undefined);
      }
    }
    if (options.durationSec) {
      const durationOption = await this.findVisibleRadioOption(page, new RegExp(`^${options.durationSec}\\s*s$`, "i"));
      if (durationOption) {
        await durationOption.click().catch(() => undefined);
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  async selectDuration(page, durationSec) {
    const option = await this.findVisibleRadioOption(page, new RegExp(`^${durationSec}\\s*s$`, "i"));
    if (option) {
      await option.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }

  async selectAspectRatio(page, aspectRatio) {
    const option = await this.findVisibleRadioOption(page, new RegExp(`^${escapeRegExp(aspectRatio)}$`, "i"));
    if (option) {
      await option.click().catch(() => undefined);
      await page.waitForTimeout(300);
    }
  }

  async findVisibleRadioOption(page, pattern) {
    const candidates = page.locator("label, [role='radio'], [role='option'], button");
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      const text = await candidate.innerText().catch(() => "");
      if (pattern.test(text.trim())) {
        return candidate;
      }
    }
    return undefined;
  }

  async waitForGenerateTrigger(page) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const trigger = await this.findGenerateTrigger(page);
      if (trigger) {
        return trigger;
      }
      await page.waitForTimeout(500);
    }
    return undefined;
  }

  async findGenerateTrigger(page) {
    const selectors = [
      "button[class*='submit-button-']:not(.lv-btn-disabled)",
      "button.lv-btn-primary:not(.lv-btn-disabled)",
    ];
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      const count = await candidates.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    }
    const textCandidates = [
      page.getByRole("button", { name: /^(立即生成|开始生成|生成|即刻想象)$/ }),
      page.locator("button").filter({ hasText: /^(立即生成|开始生成|生成|即刻想象)$/ }),
    ];
    for (const candidates of textCandidates) {
      const count = await candidates.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
    }
    return this.findPromptActionButton(page);
  }

  async findPromptActionButton(page) {
    const promptLocators = [page.locator("[contenteditable='true'][role='textbox']"), page.locator("textarea")];
    for (const prompts of promptLocators) {
      const promptCount = await prompts.count().catch(() => 0);
      for (let promptIndex = 0; promptIndex < promptCount; promptIndex += 1) {
        const prompt = prompts.nth(promptIndex);
        if (!(await prompt.isVisible().catch(() => false))) {
          continue;
        }
        for (let depth = 1; depth <= 4; depth += 1) {
          const buttons = prompt.locator(`xpath=ancestor::div[${depth}]//button[not(@disabled)]`);
          const buttonCount = await buttons.count().catch(() => 0);
          for (let buttonIndex = 0; buttonIndex < buttonCount; buttonIndex += 1) {
            const candidate = buttons.nth(buttonIndex);
            if (!(await candidate.isVisible().catch(() => false))) {
              continue;
            }
            const text = (await candidate.innerText().catch(() => "")).trim();
            if (/^(去查看|上一个|下一个|\d+:\d+)$/.test(text)) {
              continue;
            }
            if (!text || /^(立即生成|开始生成|生成|即刻想象)$/i.test(text)) {
              return candidate;
            }
          }
        }
      }
    }
    return undefined;
  }

  async waitForDownload(page, options) {
    const deadline = Date.now() + options.timeoutMs;
    let lastQueued;
    while (Date.now() < deadline) {
      const queueState = await this.detectQueueState(page);
      if (queueState) {
        const artifactPath = path.join(options.artifactDir, "queue-state.json");
        await writeJson(artifactPath, queueState);
        lastQueued = { artifactPath, queueState };
        await page.waitForTimeout(2_000);
        continue;
      }

      if (await this.isGenerationInProgress(page)) {
        await page.waitForTimeout(2_000);
        continue;
      }

      const button = await this.findDownloadButton(page);
      if (button) {
        const download = await this.clickAndAwaitDownload(page, button, 20_000).catch(() => undefined);
        if (download) {
          await ensureDir(path.dirname(options.outputPath));
          await download.saveAs(options.outputPath);
          const artifactPath = path.join(options.artifactDir, "download.json");
          await writeJson(artifactPath, {
            suggested_filename: download.suggestedFilename(),
            output_path: options.outputPath,
          });
          return { status: "downloaded", artifactPath };
        }
      }

      const mediaUrl = await this.extractMediaUrl(page, options.expectedKind, options.ignoredMediaUrls ?? new Set());
      if (mediaUrl) {
        await saveMediaUrlToFile(page, mediaUrl, options.outputPath);
        const artifactPath = path.join(options.artifactDir, "download.json");
        await writeJson(artifactPath, { media_url: mediaUrl, output_path: options.outputPath });
        return { status: "downloaded", artifactPath, downloadUrl: mediaUrl };
      }

      await page.waitForTimeout(1_000);
    }
    if (lastQueued) {
      return { status: "queued", artifactPath: lastQueued.artifactPath, queueState: lastQueued.queueState };
    }
    return undefined;
  }

  async isGenerationInProgress(page) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    return /智能创意中|生成中|正在生成|创作中|处理中|任务进行中/.test(bodyText);
  }

  async detectQueueState(page) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const normalized = bodyText.replace(/\s+/g, " ").trim();
    if (!normalized || !QUEUE_TEXT.some((pattern) => pattern.test(normalized))) {
      return undefined;
    }
    return {
      label: normalized.includes("排队加速中")
        ? "排队加速中"
        : normalized.includes("正在排队")
          ? "正在排队"
          : normalized.includes("排队中")
            ? "排队中"
            : "队列等待中",
      estimated_remaining: normalized.match(/预计剩余(?:超过)?\s*[^，。]*?(?:分钟|小时|天)/)?.[0]?.trim(),
      queue_progress: normalized.match(/\(\s*\d[\d,]*\s*\/\s*\d[\d,]*\s*\)/)?.[0]?.trim(),
      detected_text: normalized.slice(0, 240),
    };
  }

  async findDownloadButton(page) {
    const controls = page.locator("button, a, [role='button']");
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const text = await control.innerText().catch(() => "");
      if (DOWNLOAD_TEXT.some((pattern) => pattern.test(text)) && (await control.isVisible().catch(() => false))) {
        return control;
      }
    }
    return undefined;
  }

  async clickAndAwaitDownload(page, control, timeoutMs) {
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
    await control.click();
    return downloadPromise;
  }

  async collectMediaUrls(page, expectedKind) {
    const selector = expectedKind === "video" ? "video" : "img";
    const media = page.locator(selector);
    const count = await media.count().catch(() => 0);
    const urls = new Set();
    for (let index = 0; index < count; index += 1) {
      const src = await media.nth(index).getAttribute("src").catch(() => null);
      if (src?.trim()) {
        urls.add(new URL(src, page.url()).toString());
      }
    }
    return urls;
  }

  async extractMediaUrl(page, expectedKind, ignoredUrls = new Set()) {
    const selector = expectedKind === "video" ? "video" : "img";
    const media = page.locator(selector);
    const count = await media.count().catch(() => 0);
    let blobCandidate;
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = media.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      const src = await candidate.getAttribute("src").catch(() => null);
      if (!src?.trim()) {
        continue;
      }
      const resolved = new URL(src, page.url()).toString();
      if (ignoredUrls.has(resolved) || isKnownPlaceholderMediaUrl(resolved)) {
        continue;
      }
      if (!resolved.startsWith("blob:")) {
        return resolved;
      }
      blobCandidate = resolved;
    }
    return blobCandidate;
  }

  async dismissBlockingDialogs(page) {
    const candidates = page.locator("button, [role='button']").filter({
      hasText: /^(同意|我同意|同意并继续|我知道了|知道了)$/,
    });
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const button = candidates.nth(index);
      if (!(await button.isVisible().catch(() => false))) {
        continue;
      }
      await button.click().catch(() => undefined);
      await page.waitForTimeout(800);
    }
  }

  async hasVisibleLocator(locator) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  async waitingHuman(page, options) {
    await ensureDir(options.artifactDir);
    const artifactPaths = [...(options.extraArtifacts ?? [])];
    const screenshotPath = path.join(options.artifactDir, `${options.reason}.png`);
    const htmlPath = path.join(options.artifactDir, `${options.reason}.html`);
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      if (await fileExists(screenshotPath)) {
        artifactPaths.push(screenshotPath);
      }
      let html = await page.content().catch(() => "");
      if (!html.trim()) {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        html = `<!doctype html><html><body><pre>${escapeHtml(bodyText)}</pre></body></html>`;
      }
      if (html.trim()) {
        await writeFile(htmlPath, html, "utf8");
        artifactPaths.push(htmlPath);
      }
    }
    const instructionPath = path.join(options.artifactDir, "manual-instructions.json");
    await writeJson(instructionPath, {
      provider: "jimeng-skill",
      selector_version: this.selectorVersion,
      mode: options.mode,
      account_id: options.account.id,
      profile_dir: options.account.profileDir,
      waiting_human_reason: options.reason,
      expected_output_path: options.outputPath,
      prompt: options.prompt,
      reference_paths: options.referencePaths,
      resume_guidance: "If the expected output path contains the finished asset, continue from that file instead of starting a fresh JiMeng generation.",
      checklist: options.checklist ?? [
        "Open the JiMeng session for the configured account and confirm the browser stays logged in.",
        "Load the same generation mode and prompt, then upload the listed references if needed.",
        "Complete generation manually if the UI drifted or moderation/quota blocked automation.",
        "Download the final asset into the expected output path.",
      ],
      ...(options.details ?? {}),
    });
    artifactPaths.push(instructionPath);
    return {
      status: "waiting_human",
      account_id: options.account.id,
      profile_dir: options.account.profileDir,
      message: options.message,
      waiting_human_reason: options.reason,
      output_path: options.outputPath,
      artifact_dir: options.artifactDir,
      artifact_paths: artifactPaths,
      manual_instructions_path: instructionPath,
      selector_version: this.selectorVersion,
    };
  }
}

export function defaultStateDir() {
  return process.env.JIMENG_SKILL_STATE_DIR || path.join(os.homedir(), ".jimeng-skill");
}

export function parseArgs(argv) {
  const command = argv[0];
  const parsed = { _: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "headed") {
      parsed[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      parsed[key] = "";
      continue;
    }
    if (parsed[key] === undefined) {
      parsed[key] = value;
    } else if (Array.isArray(parsed[key])) {
      parsed[key].push(value);
    } else {
      parsed[key] = [parsed[key], value];
    }
    index += 1;
  }
  return { command, args: parsed };
}

export function collectReferencePaths(args) {
  const refs = [];
  for (const key of ["ref", "refs"]) {
    const value = args[key];
    if (Array.isArray(value)) {
      refs.push(...value);
    } else if (typeof value === "string") {
      refs.push(value);
    }
  }
  return refs
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
}

function requiredArg(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required --${key}`);
  }
  return value.trim();
}

function numberArg(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid numeric --${key}: ${value}`);
  }
  return numeric;
}

function commonClientOptions(args) {
  return {
    stateDir: typeof args["state-dir"] === "string" && args["state-dir"].trim() ? path.resolve(args["state-dir"]) : undefined,
    homeUrl: typeof args["home-url"] === "string" && args["home-url"].trim() ? args["home-url"].trim() : undefined,
    browserChannel: typeof args["browser-channel"] === "string" && args["browser-channel"].trim() ? args["browser-channel"].trim() : "chrome",
  };
}

function commonOperationOptions(args) {
  return {
    accountId: requiredArg(args, "account"),
    profileDir: typeof args["profile-dir"] === "string" && args["profile-dir"].trim() ? path.resolve(args["profile-dir"]) : undefined,
    homeUrl: typeof args["home-url"] === "string" && args["home-url"].trim() ? args["home-url"].trim() : undefined,
    timeoutMs: numberArg(args, "timeout-ms"),
  };
}

function normalizeMode(mode, kind) {
  const normalized = typeof mode === "string" ? mode.trim().toLowerCase().replaceAll("-", "_") : "";
  if (kind === "image") {
    return "text_to_image";
  }
  if (normalized === "image_to_video" || normalized === "agent_reference_video" || normalized === "text_to_video") {
    return normalized;
  }
  if (normalized === "agent_reference" || normalized === "agent_mode") {
    return "agent_reference_video";
  }
  return "text_to_video";
}

function resolveWorkspaceUrl(homeUrl, mode) {
  if (mode === "agent_reference_video") {
    const origin = new URL(homeUrl).origin;
    const url = new URL("/ai-tool/generate", origin);
    url.searchParams.set("enter_from", "ai_feature");
    url.searchParams.set("from_page", "explore");
    url.searchParams.set("ai_feature_name", "omniReference");
    return url.toString();
  }
  const url = new URL(homeUrl);
  if (mode === "text_to_image") {
    url.searchParams.set("type", "image");
    url.searchParams.set("workspace", "0");
  } else {
    url.searchParams.set("type", "video");
    url.searchParams.set("workspace", "0");
  }
  return url.toString();
}

function buildQueueWaitMessage(queueState) {
  const details = [queueState.label, queueState.estimated_remaining, queueState.queue_progress].filter(Boolean);
  return `JiMeng generation entered a provider queue${details.length > 0 ? `: ${details.join(" | ")}` : ""}.`;
}

function buildRunId() {
  return new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
}

function isKnownPlaceholderMediaUrl(url) {
  return /\/static\/media\/record-loading-animation/i.test(url) || /\/static\/media\/.*loading/i.test(url);
}

async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function ensureAccountProfile(account) {
  await ensureDir(account.profileDir);
  await ensureDir(path.join(account.profileDir, "downloads"));
}

async function cleanupChromeSingletonArtifacts(profileDir) {
  const candidates = ["SingletonLock", "SingletonSocket", "SingletonCookie", "RunningChromeVersion"];
  await Promise.all(candidates.map((name) => rm(path.join(profileDir, name), { force: true }).catch(() => undefined)));
}

async function downloadUrlToFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await ensureDir(path.dirname(outputPath));
  await writeFile(outputPath, bytes);
}

async function saveMediaUrlToFile(page, url, outputPath) {
  if (!url.startsWith("blob:")) {
    await downloadUrlToFile(url, outputPath);
    return;
  }
  const base64 = await page.evaluate(async (mediaUrl) => {
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      throw new Error(`Blob download failed with HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }, url);
  await ensureDir(path.dirname(outputPath));
  await writeFile(outputPath, Buffer.from(base64, "base64"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  const client = new JimengClient(commonClientOptions(args));
  let result;

  switch (command) {
    case undefined:
    case "":
    case "help":
    case "--help":
    case "-h":
      result = usageResult();
      break;
    case "login":
      result = await client.login(commonOperationOptions(args));
      break;
    case "check":
      result = await client.checkSession(commonOperationOptions(args));
      break;
    case "generate-image":
    case "generate-video": {
      const kind = command === "generate-image" ? "image" : "video";
      const outputPath = path.resolve(requiredArg(args, "output"));
      if (await fileExists(outputPath) && args.overwrite !== "true") {
        result = {
          status: "exists",
          output_path: outputPath,
          message: "Output already exists. Pass --overwrite true to replace it.",
        };
        break;
      }
      result = await client.generate({
        ...commonOperationOptions(args),
        kind,
        prompt: requiredArg(args, "prompt"),
        outputPath,
        referencePaths: collectReferencePaths(args),
        mode: typeof args.mode === "string" ? args.mode : undefined,
        durationSec: numberArg(args, "duration"),
        aspectRatio: typeof args.ratio === "string" ? args.ratio.trim() : undefined,
        headed: args.headed === true,
      });
      break;
    }
    default:
      result = {
        status: "error",
        message: `Unknown command '${command ?? ""}'.`,
        usage: usageResult().commands,
      };
      process.exitCode = 1;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "timeout" || result.status === "waiting_human" || result.status === "needs_login") {
    process.exitCode = 2;
  }
}

function usageResult() {
  return {
    status: "usage",
    commands: [
      "node scripts/jimeng.mjs login --account <account_id>",
      "node scripts/jimeng.mjs check --account <account_id>",
      "node scripts/jimeng.mjs generate-image --account <account_id> --prompt <text> --output <file>",
      "node scripts/jimeng.mjs generate-video --account <account_id> --prompt <text> --output <file>",
    ],
    options: [
      "--refs <file1,file2>",
      "--ref <file>",
      "--mode text-to-video|image-to-video|agent-reference-video",
      "--duration <seconds>",
      "--ratio <W:H>",
      "--headed",
      "--profile-dir <dir>",
      "--state-dir <dir>",
      "--home-url <url>",
      "--timeout-ms <n>",
    ],
  };
}

const entryPath = process.argv[1] ? fileURLToPath(new URL(`file://${path.resolve(process.argv[1])}`)) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
