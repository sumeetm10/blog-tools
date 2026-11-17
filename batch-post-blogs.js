const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ─── Config ───
const API_BASE = "https://api.nepsetrading.com";
const DEFAULT_FILE = path.join(__dirname, "blogs-to-post.json");
const DELAY_MS = 800;

// ─── Parse CLI args ───
const args = process.argv.slice(2);
const getArg = (name) => {
  const a = args.find((a) => a.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const filePath = getArg("file") || DEFAULT_FILE;
const dryRun = hasFlag("dry-run");
const skipPublish = hasFlag("no-publish");
const delay = parseInt(getArg("delay") || DELAY_MS, 10);
// Resume a run that died partway: --from=15 skips items 1-14 (1-based, the
// numbers printed as [N] in the log). Re-running the whole file instead would
// publish every already-posted blog a second time, because the backend gives a
// repeated title a "-2" slug rather than rejecting it.
const fromIndex = Math.max(1, parseInt(getArg("from") || "1", 10) || 1);

// ─── Backend mode (Rust = JSON body, Nest = multipart/form-data) ───
// Default = "rust" since the production API is on Rust now.
// Pass --backend=nest to send the legacy multipart body shape.
const backend = (getArg("backend") || "rust").toLowerCase();
if (backend !== "rust" && backend !== "nest") {
  console.error(`❌ Invalid --backend=${backend}. Use 'rust' or 'nest'.`);
  process.exit(1);
}

// Fresh JWT via POST /auth/login, so CI never depends on a pasted cookie.
async function loginForJwt(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`login failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  }
  if (json.requires_mfa) {
    throw new Error("login returned requires_mfa; this account cannot be used headlessly. Supply BLOG_JWT instead.");
  }
  if (!json.access_token) {
    throw new Error(`login response had no access_token: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.access_token;
}

// Titles already published, so a re-run on the same day does not post every
// blog again with a "-2" slug.
async function existingTitles() {
  try {
    const res = await fetch(`${API_BASE}/blog-v2?limit=100&status=published`);
    if (!res.ok) return new Set();
    const json = await res.json();
    return new Set((json.data || []).map((b) => String(b.title || "").trim()));
  } catch {
    return new Set();
  }
}

// ─── Get JWT ───
async function getJwt() {
  // 1. Env var
  if (process.env.BLOG_JWT) {
    console.log("🔑 Using JWT from BLOG_JWT env var");
    return process.env.BLOG_JWT;
  }

  // 1b. Login (CI). Ahead of the .jwt file so CI never uses a stale token.
  if (process.env.NEPSE_EMAIL && process.env.NEPSE_PASSWORD) {
    console.log("🔑 Logging in for a fresh JWT");
    return await loginForJwt(process.env.NEPSE_EMAIL, process.env.NEPSE_PASSWORD);
  }

  // 2. CLI arg
  const cliJwt = getArg("jwt");
  if (cliJwt) {
    console.log("🔑 Using JWT from --jwt arg");
    return cliJwt;
  }

  // 3. JWT file
  const jwtFile = path.join(__dirname, ".jwt");
  if (fs.existsSync(jwtFile)) {
    const token = fs.readFileSync(jwtFile, "utf-8").trim();
    if (token) {
      console.log("🔑 Using JWT from .jwt file");
      return token;
    }
  }

  // 4. Prompt (never in CI: nobody can answer it and the job would hang)
  if (process.env.CI) {
    throw new Error("no JWT: set NEPSE_EMAIL and NEPSE_PASSWORD (or BLOG_JWT) as secrets");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(
      "🔑 Paste your JWT token (from browser DevTools > Application > Cookies > jwt): ",
      (answer) => {
        rl.close();
        const token = answer.trim();
        // Save for next time
        fs.writeFileSync(jwtFile, token, "utf-8");
        console.log("   Saved to .jwt for next run");
        resolve(token);
      }
    );
  });
}

// ─── Body builders for both backends ───

// NestJS: multipart/form-data via FileInterceptor + class-validator
function buildFormData(blog) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(blog)) {
    if (v === undefined || v === null) continue;
    if (k === "tags" && Array.isArray(v)) {
      v.forEach((t, i) => fd.append(`tags[${i}]`, String(t)));
    } else if (k === "secondary_keywords" && Array.isArray(v)) {
      v.forEach((w, i) => fd.append(`secondary_keywords[${i}]`, String(w)));
    } else if (
      ["bullet_key_points", "faqs", "entity_tags", "source_citations", "data_table"].includes(k)
    ) {
      fd.append(k, JSON.stringify(v));
    } else {
      fd.append(k, String(v));
    }
  }
  return fd;
}

// Rust (Axum): application/json body matching CreateBlogBody
// Rust DTO declares some fields as Option<String> but expects them JSON-stringified
// (matching the legacy NestJS multipart shape) — so we stringify those.
const STRINGIFIED_JSON_FIELDS = new Set([
  "bullet_key_points",
  "faqs",
  "entity_tags",
  "source_citations",
  "data_table",
]);
const ARRAY_FIELDS = new Set(["tags", "secondary_keywords"]);

function buildJsonBody(blog) {
  const out = {};
  for (const [k, v] of Object.entries(blog)) {
    if (v === undefined || v === null) continue;
    if (STRINGIFIED_JSON_FIELDS.has(k)) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    } else if (ARRAY_FIELDS.has(k)) {
      out[k] = Array.isArray(v) ? v.map(String) : [];
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Safely read a response: parse JSON if possible, otherwise return raw text.
async function readBody(res) {
  const text = await res.text().catch(() => "");
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

// ─── Post one blog ───
// fetch() THROWS on a network failure ("fetch failed") instead of returning a
// response. On 2026-10-09 one dropped connection on item 15 escaped postBlog,
// reached main().catch and killed the run: items 15-20 were never posted and the
// summary never printed.
//
// Retrying is only safe when the request provably never reached the server.
// A CREATE that did reach it may have succeeded with the reply lost, and a blind
// retry would publish a duplicate under a "-2" slug. So:
//   - connect-stage failures (refused / DNS / connect timeout): retried, any call
//   - failures after the request was sent: retried only when idempotent (the
//     publish PATCH); for a create they are reported as UNKNOWN, not guessed at.
const PRE_SEND_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function netCode(e) {
  const c = e && e.cause;
  // Node tries IPv4 and IPv6 in parallel and wraps the losers in an
  // AggregateError, so a refused connection has no top-level code - read the
  // first inner error's, or it is mistaken for a request that was sent.
  const inner = c && Array.isArray(c.errors) && c.errors.find((x) => x && x.code);
  return (c && c.code) || (inner && inner.code) || (e && e.code) || (c && c.name) || "unknown";
}
async function fetchRetry(url, opts, { idempotent }) {
  const waits = [2000, 5000, 12000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      const code = netCode(e);
      const safe = idempotent || PRE_SEND_CODES.has(code);
      if (!safe || attempt >= waits.length) {
        const err = new Error(`network error (${code})`);
        err.code = code;
        err.maybeSent = !PRE_SEND_CODES.has(code);
        throw err;
      }
      console.log(`   network error (${code}) - retrying in ${waits[attempt] / 1000}s`);
      await new Promise((r) => setTimeout(r, waits[attempt]));
    }
  }
}

async function postBlog(blog, jwt, index) {
  const label = `[${index}] "${blog.title.substring(0, 50)}..."`;

  if (dryRun) {
    console.log(`✅ ${label} — DRY RUN (skipped)`);
    return { ok: true, id: "dry", slug: "dry-run", title: blog.title };
  }

  // Step 1: Create — body shape depends on which backend is live
  const payload = { ...blog, status: "draft" };
  const createReq =
    backend === "rust"
      ? {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildJsonBody(payload)),
        }
      : {
          // NestJS: do NOT set Content-Type manually — fetch + FormData sets the boundary
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}` },
          body: buildFormData(payload),
        };

  let createRes;
  try {
    createRes = await fetchRetry(`${API_BASE}/blog-v2`, createReq, { idempotent: false });
  } catch (e) {
    const why = e.maybeSent
      ? "connection dropped AFTER sending - it MAY have been created; check the site before re-posting this one"
      : "server unreachable - nothing was created";
    console.log(`❌ ${label} — CREATE ${e.message}: ${why}`);
    return { ok: false, error: { network: e.code, maybeCreated: !!e.maybeSent }, step: "create", title: blog.title };
  }
  const { json: createJson, text: createText } = await readBody(createRes);

  if (!createRes.ok) {
    const errPreview = (createJson ? JSON.stringify(createJson) : createText).substring(0, 200);
    console.log(`❌ ${label} — CREATE failed (status ${createRes.status}): ${errPreview}`);
    return {
      ok: false,
      error: createJson || { raw: createText },
      step: "create",
      title: blog.title,
      status: createRes.status,
    };
  }

  if (!createJson) {
    console.log(`❌ ${label} — CREATE returned non-JSON body (status ${createRes.status}): ${createText.substring(0, 200)}`);
    return {
      ok: false,
      error: { raw: createText },
      step: "create",
      title: blog.title,
      status: createRes.status,
    };
  }

  // Both Rust and NestJS responses use {data: {id, slug}} but Rust may also use {status:"success", data:{...}}
  const data = createJson.data || createJson;
  const slug = data.slug;
  const id = data.id;
  if (!slug) {
    console.log(`❌ ${label} — CREATE 200 but no slug in response: ${createText.substring(0, 200)}`);
    return { ok: false, error: createJson, step: "create", title: blog.title };
  }

  // Step 2: Publish
  if (!skipPublish) {
    await new Promise((r) => setTimeout(r, delay));
    let pubRes;
    try {
      pubRes = await fetchRetry(`${API_BASE}/blog-v2/${slug}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "published" }),
    }, { idempotent: true });
    } catch (e) {
      console.log(`⚠️  ${label} — Created (ID:${id}) as DRAFT but PUBLISH ${e.message}; publish slug ${slug} by hand`);
      return { ok: false, id, slug, error: { network: e.code }, step: "publish", title: blog.title };
    }

    if (!pubRes.ok) {
      const { json: pubJson, text: pubText } = await readBody(pubRes);
      const errPreview = (pubJson ? JSON.stringify(pubJson) : pubText).substring(0, 150);
      console.log(`⚠️  ${label} — Created (ID:${id}) but PUBLISH failed (status ${pubRes.status}): ${errPreview}`);
      return {
        ok: false,
        id,
        slug,
        error: pubJson || { raw: pubText },
        step: "publish",
        title: blog.title,
        status: pubRes.status,
      };
    }
  }

  const status = skipPublish ? "draft" : "published";
  console.log(`✅ ${label} — ID:${id} | slug:${slug} | ${status}`);
  return { ok: true, id, slug, title: blog.title };
}

// ─── Main ───
async function main() {
  console.log("\n📝 Blog Batch Poster\n");

  // Load blogs
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    console.error(`   Create it or use --file=path/to/blogs.json`);
    process.exit(1);
  }

  let blogs;
  try {
    blogs = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error(`❌ Invalid JSON in ${filePath}: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(blogs) || blogs.length === 0) {
    console.error("❌ blogs-to-post.json must be a non-empty array");
    process.exit(1);
  }

  console.log(`📄 Loaded ${blogs.length} blog(s) from ${path.basename(filePath)}`);
  if (dryRun) console.log("🔍 DRY RUN mode — no API calls will be made\n");
  if (skipPublish) console.log("📋 NO-PUBLISH mode — blogs will be created as drafts only\n");

  // Get JWT
  const jwt = dryRun ? "dry-run" : await getJwt();

  console.log(`🛠️  Backend mode: ${backend.toUpperCase()} (POST body = ${backend === "rust" ? "JSON" : "multipart/form-data"})`);

  // Validate JWT against a PROTECTED endpoint so stale tokens / invalid sessions fail fast.
  // Rust:    GET /auth/me      (canonical session check)
  // NestJS:  GET /user/me      (AuthGuard + Redis session verify)
  if (!dryRun) {
    const meEndpoint = backend === "rust" ? "/auth/me" : "/user/me";
    console.log(`🔄 Validating JWT against ${meEndpoint} ...`);
    const testRes = await fetch(`${API_BASE}${meEndpoint}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (testRes.status === 401) {
      const { text } = await readBody(testRes);
      console.error("❌ JWT invalid / session expired:", text.substring(0, 200));
      console.error("   1) Log into https://nepsetrading.com (fresh login, not a restored tab)");
      console.error("   2) DevTools > Application > Cookies > copy the 'jwt' value");
      console.error("   3) Overwrite .jwt in this folder (use Notepad — cmd paste is unreliable)");
      process.exit(1);
    }
    if (testRes.status === 403) {
      console.error("❌ JWT valid but user lacks required role. Ask an admin to grant 'admin_blog'.");
      process.exit(1);
    }
    if (!testRes.ok) {
      const { text } = await readBody(testRes);
      console.error(`❌ ${meEndpoint} returned unexpected status ${testRes.status}: ${text.substring(0, 200)}`);
      process.exit(1);
    }
    console.log("✅ JWT valid\n");
  }

  // Skip blogs already published under the same title
  const seen = dryRun ? new Set() : await existingTitles();
  const before = blogs.length;
  blogs = blogs.filter((b) => !seen.has(String(b.title || "").trim()));
  if (blogs.length < before) {
    console.log(`Skipping ${before - blogs.length} blog(s) already published.`);
  }
  if (blogs.length === 0) {
    console.log("Nothing new to post.");
    return;
  }

  // Post each blog
  const results = [];
  if (fromIndex > 1) console.log(`Resuming at item ${fromIndex} (skipping 1-${fromIndex - 1})
`);
  for (let i = fromIndex - 1; i < blogs.length; i++) {
    let result;
    try {
      result = await postBlog(blogs[i], jwt, i + 1);
    } catch (e) {
      // Belt and braces: anything postBlog did not anticipate fails THIS item
      // only, so the rest still post and the summary still prints.
      console.log(`❌ [${i + 1}] unexpected error: ${e.message}`);
      result = { ok: false, error: { message: e.message }, step: "unknown", title: blogs[i].title || "" };
    }
    results.push(result);
    if (i < blogs.length - 1 && !dryRun) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Summary
  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`✅ Published: ${ok}  |  ❌ Failed: ${fail}  |  Total: ${results.length}`);

  if (fail > 0) {
    console.log("\nFailed blogs:");
    results
      .filter((r) => !r.ok)
      .forEach((r) => console.log(`  - ${r.title.substring(0, 60)} [${r.step}]: ${JSON.stringify(r.error).substring(0, 80)}`));
  }

  console.log(`\nPublished blogs:`);
  results
    .filter((r) => r.ok)
    .forEach((r) => console.log(`  ID:${r.id} | ${r.slug}`));

  console.log();
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
