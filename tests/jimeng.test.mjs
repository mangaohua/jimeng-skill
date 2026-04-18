import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JimengClient, collectReferencePaths, parseArgs } from "../scripts/jimeng.mjs";

test("argument parsing supports repeated and comma-separated references", () => {
  const { command, args } = parseArgs([
    "generate-video",
    "--account",
    "main",
    "--prompt",
    "demo",
    "--ref",
    "a.png",
    "--refs",
    "b.png,c.png",
    "--headed",
  ]);

  assert.equal(command, "generate-video");
  assert.equal(args.account, "main");
  assert.equal(args.headed, true);
  assert.deepEqual(
    collectReferencePaths(args).map((candidate) => path.basename(candidate)),
    ["a.png", "b.png", "c.png"],
  );
});

test("checkSession distinguishes expired and valid persistent profiles", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "jimeng-skill-session-"));
  const server = createMockJimengServer();
  await server.start();
  const client = new JimengClient({ stateDir, homeUrl: server.url("/home"), browserChannel: undefined });

  try {
    const expired = await client.checkSession({ accountId: "expired" });
    assert.equal(expired.status, "needs_login");
    assert.equal(expired.needs_login, true);

    const seeded = await seedLoginProfile(t, client, "valid", server.url("/set-login"));
    if (!seeded) {
      return;
    }

    const valid = await client.checkSession({ accountId: "valid" });
    assert.equal(valid.status, "ready");
    assert.equal(valid.needs_login, false);
  } finally {
    await server.close();
  }
});

test("generate downloads a JiMeng result through the browser flow", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "jimeng-skill-generate-"));
  const server = createMockJimengServer();
  await server.start();
  const client = new JimengClient({ stateDir, homeUrl: server.url("/home"), browserChannel: undefined });

  try {
    const seeded = await seedLoginProfile(t, client, "creator", server.url("/set-login"));
    if (!seeded) {
      return;
    }

    const outputPath = path.join(stateDir, "outputs", "demo.mp4");
    const result = await client.generate({
      accountId: "creator",
      kind: "video",
      prompt: "生成一个 9:16 产品种草视频",
      outputPath,
      referencePaths: [],
      mode: "text-to-video",
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "success");
    assert.equal(result.output_path, outputPath);
    assert.match(await readFile(outputPath, "utf8"), /mock-video-binary/);
  } finally {
    await server.close();
  }
});

test("generate can upload references for agent reference video mode", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "jimeng-skill-agent-"));
  const server = createMockJimengServer({ agentMode: true });
  await server.start();
  const client = new JimengClient({ stateDir, homeUrl: server.url("/home"), browserChannel: undefined });

  try {
    const seeded = await seedLoginProfile(t, client, "agent", server.url("/set-login"));
    if (!seeded) {
      return;
    }

    const refPath = path.join(stateDir, "ref.png");
    await writeFile(refPath, "mock-image");
    const outputPath = path.join(stateDir, "outputs", "agent.mp4");
    const result = await client.generate({
      accountId: "agent",
      kind: "video",
      prompt: "基于参考图生成 10 秒竖屏视频",
      outputPath,
      referencePaths: [refPath],
      mode: "agent-reference-video",
      durationSec: 10,
      aspectRatio: "9:16",
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "success");
    assert.match(await readFile(outputPath, "utf8"), /mock-video-binary/);
  } finally {
    await server.close();
  }
});

test("generate records provider_queue_wait when JiMeng enters a long queue", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "jimeng-skill-queue-"));
  const server = createMockJimengServer({ queueAfterGenerate: true });
  await server.start();
  const client = new JimengClient({ stateDir, homeUrl: server.url("/home"), browserChannel: undefined });

  try {
    const seeded = await seedLoginProfile(t, client, "queued", server.url("/set-login"));
    if (!seeded) {
      return;
    }

    const outputPath = path.join(stateDir, "outputs", "queued.mp4");
    const result = await client.generate({
      accountId: "queued",
      kind: "video",
      prompt: "排队测试视频",
      outputPath,
      mode: "text-to-video",
      timeoutMs: 2_500,
    });

    assert.equal(result.status, "waiting_human");
    assert.equal(result.waiting_human_reason, "provider_queue_wait");
    assert.ok(result.manual_instructions_path);
    const instructions = JSON.parse(await readFile(result.manual_instructions_path, "utf8"));
    assert.equal(instructions.expected_output_path, outputPath);
    assert.equal(instructions.queue_state.label, "排队加速中");
  } finally {
    await server.close();
  }
});

test("generate returns manual takeover artifacts when the generate button drifts", async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "jimeng-skill-drift-"));
  const server = createMockJimengServer({ drift: true });
  await server.start();
  const client = new JimengClient({ stateDir, homeUrl: server.url("/home"), browserChannel: undefined });

  try {
    const seeded = await seedLoginProfile(t, client, "drift", server.url("/set-login"));
    if (!seeded) {
      return;
    }

    const result = await client.generate({
      accountId: "drift",
      kind: "image",
      prompt: "生成一张图",
      outputPath: path.join(stateDir, "outputs", "drift.png"),
      timeoutMs: 2_000,
    });

    assert.equal(result.status, "waiting_human");
    assert.equal(result.waiting_human_reason, "selector_drift_generate_trigger");
    assert.ok(result.artifact_paths.some((candidate) => candidate.endsWith(".html")));
    assert.ok(result.artifact_paths.some((candidate) => candidate.endsWith("manual-instructions.json")));
  } finally {
    await server.close();
  }
});

async function seedLoginProfile(t, client, accountId, url) {
  let context;
  try {
    context = await client.launchContext(client.resolveAccount(accountId), { headless: true });
  } catch (error) {
    t.skip(`Playwright browser is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return true;
  } finally {
    await context.close();
  }
}

function createMockJimengServer(options = {}) {
  let server;
  let port;
  const cookieName = `jimeng_auth_${Math.random().toString(16).slice(2)}`;

  return {
    async start() {
      server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const cookie = req.headers.cookie ?? "";
        res.setHeader("Content-Type", "text/html; charset=utf-8");

        if (requestUrl.pathname === "/set-login") {
          res.setHeader("Set-Cookie", `${cookieName}=1; Path=/; Max-Age=3600`);
          res.end("<html><body>JiMeng ready</body></html>");
          return;
        }

        if (requestUrl.pathname === "/download/mock.mp4") {
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Content-Disposition", "attachment; filename=mock.mp4");
          res.end("mock-video-binary");
          return;
        }

        if (requestUrl.pathname === "/download/mock.png") {
          res.setHeader("Content-Type", "image/png");
          res.setHeader("Content-Disposition", "attachment; filename=mock.png");
          res.end("mock-image-binary");
          return;
        }

        if (!cookie.includes(`${cookieName}=1`)) {
          res.end("<html><body><button>登录</button><div>请先登录</div></body></html>");
          return;
        }

        if (options.loginGate) {
          res.end("<html><body><button>登录</button><div>同意协议后前往登录</div></body></html>");
          return;
        }

        const isImage = requestUrl.searchParams.get("type") === "image";
        res.end(renderWorkspace({
          ...options,
          isImage,
        }));
      });

      await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          port = server.address().port;
          resolve();
        });
      });
    },
    url(pathname) {
      return `http://127.0.0.1:${port}${pathname}`;
    },
    async close() {
      if (!server) {
        return;
      }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function renderWorkspace(options) {
  const downloadPath = options.isImage ? "/download/mock.png" : "/download/mock.mp4";
  const agentControls = options.agentMode
    ? '<div role="combobox">Agent 模式</div><label role="radio">9:16</label><label role="radio">10s</label><button>自动</button>'
    : '<label role="radio">9:16</label><label role="radio">5s</label><label role="radio">10s</label>';
  const generateButton = options.drift
    ? ""
    : `<button class="lv-btn-primary" onclick="generate()">立即生成</button>`;
  const uploadInput = options.drift ? "" : '<input type="file" multiple>';

  return `<!doctype html>
    <html>
      <body>
        <main>
          ${agentControls}
          <div>
            <div contenteditable="true" role="textbox" aria-label="prompt"></div>
            ${uploadInput}
            ${generateButton}
          </div>
          <div id="result"></div>
        </main>
        <script>
          function generate() {
            if (${JSON.stringify(Boolean(options.queueAfterGenerate))}) {
              document.body.innerHTML = '<div>排队加速中 预计剩余 10 分钟 (1/100)</div>';
              return;
            }
            document.getElementById('result').innerHTML = '<button onclick="downloadMock()">下载</button>';
          }
          function downloadMock() {
            const anchor = document.createElement('a');
            anchor.href = ${JSON.stringify(downloadPath)};
            anchor.download = ${JSON.stringify(options.isImage ? "mock.png" : "mock.mp4")};
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
          }
        </script>
      </body>
    </html>`;
}
