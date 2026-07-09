
// ===================================================================================
// bytelab-ai Worker
// نسخه جدید: پشتیبانی از تصویر (Vision)، خوندن چند صفحه سایت، و پاسخ بهتر
// + رفع خودکار خطای 5016 (پذیرش توافق‌نامه Llama Vision)
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

// مدل تصویر (Vision)
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

// تشخیص و قطع حلقه‌های تکراری در دو سطح:
// ۱) تکرار جمله‌های کامل   ۲) تکرار یک عبارت/کلمه چندبار پشت‌سرهم وسط متن (بدون نقطه)
function cutRepetition(text) {
  if (!text) return text;

  // --- سطح ۱: تکرار عبارت/کلمه (n-gram) پشت‌سرهم ---
  const words = text.split(/\s+/);
  for (let winSize = 1; winSize <= 8; winSize++) {
    for (let i = 0; i + winSize * 3 <= words.length; i++) {
      const a = words.slice(i, i + winSize).join(" ");
      const b = words.slice(i + winSize, i + 2 * winSize).join(" ");
      const c = words.slice(i + 2 * winSize, i + 3 * winSize).join(" ");
      if (a && a === b && a === c) {
        // همین که یک عبارت سه‌بار پشت‌سرهم تکرار شد، درست قبل از شروع حلقه قطع می‌کنیم
        const cutWords = words.slice(0, i + winSize);
        text = cutWords.join(" ").trim();
        if (!/[.!؟?]$/.test(text)) text += ".";
        break;
      }
    }
  }

  // --- سطح ۲: تکرار جمله‌های کامل ---
  const sentences = text.split(/(?<=[.!؟?])\s+/).filter(Boolean);
  const seen = new Map();
  const result = [];
  for (const s of sentences) {
    const key = s.trim();
    if (!key) continue;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count > 2) break;
    result.push(s);
  }
  const finalText = result.join(" ").trim();
  return finalText || text.slice(0, 300).trim();
}

async function runVision(env, imageBase64, promptText) {
  const imageBytes = base64ToBytes(imageBase64);

  async function callModel() {
    const result = await env.AI.run(VISION_MODEL, {
      image: imageBytes,
      prompt: promptText,
      max_tokens: 220,
      temperature: 0.2,
    });
    if (!result || !result.response) {
      throw new Error("مدل تصویر پاسخ خالی برگرداند.");
    }
    return cutRepetition(result.response);
  }

  try {
    return await callModel();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // خطای 5016 یعنی هنوز توافق‌نامه Meta برای این اکانت پذیرفته نشده.
    // یک‌بار خودکار درخواست "agree" رو می‌فرستیم و دوباره تلاش می‌کنیم.
    const needsAgreement =
      msg.includes("5016") ||
      msg.toLowerCase().includes("agree") ||
      msg.toLowerCase().includes("license");

    if (!needsAgreement) throw err;

    try {
      await env.AI.run(VISION_MODEL, { prompt: "agree" });
    } catch (agreeErr) {
      // اگه خود درخواست agree هم خطا داد، همون خطای اصلی رو پرتاب کن
      throw err;
    }

    // تلاش دوم بعد از پذیرش توافق‌نامه
    return await callModel();
  }
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

        const visionPrompt = `فقط بر اساس چیزی که واقعاً توی عکس می‌بینی، به فارسی و در حداکثر ۳ جمله کوتاه جواب بده. هیچ کلمه یا جمله‌ای رو تکرار نکن. هیچ برچسب، شماره، یا حرف (مثل الف، ب، ج، ۱، ۲) توی جوابت ننویس؛ فقط متن ساده و روان بنویس.

راهنمای داخلی (توی جواب نیار، فقط طبق این تصمیم بگیر):
- اگر عکس نشون‌دهنده خطا، پیغام سیستم، یا مشکل نرم‌افزاری/کده: بگو مشکل چیه و راه‌حلش رو بگو.
- اگر عکس یک طرح گرافیکی، رابط کاربری (UI/UX)، یا نمونه‌کار طراحیه: سبک بصری رو توصیف کن و بگو بایت‌لب چه امکانات مشابهی می‌تونه پیاده کنه.
- در غیر این صورت (منظره، خیابون، حیوان، آدم، غذا، یا هر چیز عادی دیگه): فقط صادقانه توصیف کن چی توی عکس هست، بدون هیچ اشاره‌ای به بایت‌لب یا خطای فنی.

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
                (visionErr && visionErr.message ? visionErr.message : String(visionErr)),
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
