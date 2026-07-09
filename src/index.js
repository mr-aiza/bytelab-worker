// ===================================================================================
// bytelab-ai Worker
// نسخه جدید: پشتیبانی از تصویر (Vision)، خوندن چند صفحه سایت، و پاسخ بهتر
// ===================================================================================

const BASE_URL = "https://bytelabpro.xyz";

// صفحاتی که هوش مصنوعی برای شناخت کامل سایت می‌خونه (به ترتیب اهمیت)
const SITE_PAGES = [
  "/index.html",
  "/tarahi-site.html",
  "/tarahi-app.html",
  "/khadamat-computer.html",
  "/hazine-tarahi-site.html",
  "/portfolio.html",
  "/blog.html",
];

// هر صفحه حداکثر چقدر کاراکتر توی کانتکست بیاد (جمعاً حدود ۶۰۰۰ کاراکتر)
const PER_PAGE_CHAR_LIMIT = 850;

// مدل‌های متنی به ترتیب اولویت (سبک‌تر اول، سنگین‌تر fallback)
const TEXT_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
];

// مدل تصویر (Vision) — قبل از اولین استفاده باید یک‌بار توافق‌نامه Meta پذیرفته بشه
// (توضیح در پیام همراه کد)
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const DEFAULT_MAX_TOKENS = 900;
const HARD_MAX_TOKENS = 1400;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// خوندن همزمان چند صفحه از سایت و ترکیب‌شون به یک کانتکست زنده
async function getSiteContext() {
  const fetches = SITE_PAGES.map(async (path) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(BASE_URL + path, {
        cf: { cacheTtl: 600, cacheEverything: true },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return "";
      const html = await res.text();
      const text = stripHtml(html);
      return `--- صفحه ${path} ---\n${text.slice(0, PER_PAGE_CHAR_LIMIT)}`;
    } catch (e) {
      return "";
    }
  });

  const results = await Promise.all(fetches);
  return results.filter(Boolean).join("\n\n");
}

async function runTextWithFallback(env, aiMessages, maxTokens) {
  let lastError = null;
  const safeMaxTokens = Math.min(
    Math.max(parseInt(maxTokens, 10) || DEFAULT_MAX_TOKENS, 256),
    HARD_MAX_TOKENS
  );
  for (const model of TEXT_MODELS) {
    try {
      const result = await env.AI.run(model, {
        messages: aiMessages,
        max_tokens: safeMaxTokens,
      });
      if (result && result.response) {
        return { response: result.response, modelUsed: model };
      }
      lastError = new Error(`مدل ${model} پاسخ خالی برگرداند.`);
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError || new Error("همه مدل‌ها شکست خوردند.");
}

// تبدیل data URL یا base64 خام به آرایه بایت که Workers AI انتظار داره
function base64ToBytes(base64Input) {
  const clean = base64Input.includes(",") ? base64Input.split(",")[1] : base64Input;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return Array.from(bytes);
}

async function runVision(env, imageBase64, promptText) {
  const imageBytes = base64ToBytes(imageBase64);
  const result = await env.AI.run(VISION_MODEL, {
    image: imageBytes,
    prompt: promptText,
    max_tokens: 700,
  });
  if (!result || !result.response) {
    throw new Error("مدل تصویر پاسخ خالی برگرداند.");
  }
  return result.response;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // حالت دیباگ: تست سریع از مرورگر
    if (request.method === "GET") {
      try {
        const testMessages = [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "بگو 'سلام، من فعالم'" },
        ];
        const { response, modelUsed } = await runTextWithFallback(env, testMessages);
        return new Response(
          "✅ همه‌چیز سالمه!\nمدل استفاده‌شده: " + modelUsed + "\nجواب: " + response,
          { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(
          "❌ خطا در تماس با AI:\n" + (err && err.message ? err.message : String(err)),
          { status: 500, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    try {
      const body = await request.json();
      const { system, messages, image, max_tokens } = body;

      const siteContext = await getSiteContext();
      const fullSystem = `${system || ""}

===== اطلاعات زنده سایت بایت‌لب (چند صفحه، تازه‌خوانی‌شده) =====
${siteContext}
===== پایان اطلاعات سایت =====`;

      // ---- حالت تصویر: کاربر عکس فرستاده ----
      if (image) {
        const lastUserText =
          (messages && messages.length
            ? messages[messages.length - 1].content
            : "") || "این تصویر رو بررسی کن.";

        const visionPrompt = `تو دستیار هوش مصنوعی بایت‌لب (BYTELAB) هستی، به فارسی روان و کوتاه جواب بده.
اگر عکس یک خطا/پیغام سیستم/موبایل/کامپیوتر یا صفحه سایت/اپه، مشکل رو تشخیص بده و راه‌حل مرحله‌به‌مرحله بده.
اگر عکس یک طرح، رفرنس طراحی، یا نمونه‌کاره، درباره سبک و امکانات مشابهی که بایت‌لب می‌تونه پیاده کنه نظر بده.
درخواست/پیام کاربر همراه عکس: "${lastUserText}"`;

        try {
          const visionResponse = await runVision(env, image, visionPrompt);
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: visionResponse }],
              _debug_model: VISION_MODEL,
            }),
            { headers: { ...cors, "Content-Type": "application/json" } }
          );
        } catch (visionErr) {
          return new Response(
            JSON.stringify({
              error:
                "خطا در تحلیل تصویر: " +
                (visionErr && visionErr.message ? visionErr.message : String(visionErr)) +
                " — اگه اولین باره از این مدل استفاده می‌کنی، باید یک‌بار توافق‌نامه مدل Llama Vision رو در داشبورد Cloudflare AI بپذیری.",
            }),
            { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
          );
        }
      }

      // ---- حالت معمولی: متن ----
      const aiMessages = [
        { role: "system", content: fullSystem },
        ...(messages || []).map((m) => ({ role: m.role, content: m.content })),
      ];

      const { response, modelUsed } = await runTextWithFallback(env, aiMessages, max_tokens);

      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: response || "پاسخی دریافت نشد." }],
          _debug_model: modelUsed,
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "خطا: " + (err && err.message ? err.message : String(err)) }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
  },
};
