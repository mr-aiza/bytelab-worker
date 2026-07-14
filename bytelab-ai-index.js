// ===================================================================================
// bytelab-ai Worker — نسخه کامل
// شامل: تصویر (چندتایی)، صدا، کش سایت (Cache API)، رفع تکرار، انتخاب هوشمند مدل،
// فیلتر پایه ورودی، fallback دوستانه، دکمه‌های پیشنهادی
// ===================================================================================

const BASE_URL = "https://bytelabpro.xyz";

const SITE_PAGES = [
  "/index.html",
  "/tarahi-site.html",
  "/tarahi-app.html",
  "/khadamat-computer.html",
  "/hazine-tarahi-site.html",
  "/portfolio.html",
  "/blog.html",
];

const PER_PAGE_CHAR_LIMIT = 850;
const SITE_CONTEXT_CACHE_SECONDS = 600; // ۱۰ دقیقه کش

// مدل سبک (سریع) و مدل سنگین (باهوش‌تر ولی کندتر)
const LIGHT_MODELS = ["@cf/meta/llama-3.1-8b-instruct-fast"];
const HEAVY_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast"];

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const WHISPER_MODEL = "@cf/openai/whisper";

const DEFAULT_MAX_TOKENS = 900;
const HARD_MAX_TOKENS = 4096;

const MAX_USER_MESSAGE_LENGTH = 2000; // کاراکتر
const MAX_IMAGE_BASE64_LENGTH = 7_000_000; // تقریباً ۵ مگابایت فایل واقعی
const MAX_IMAGES_PER_REQUEST = 2;

// ---- محدودیت رایگان روزانه Workers AI: ۱۰٬۰۰۰ Neuron در روز، ریست ساعت ۰۰:۰۰ UTC ----
// چون این محدودیت مشترک بین همه‌ی درخواست‌هاست (چت عمومی سایت + نویسنده خودکار بلاگ)،
// یه سقف روزانه‌ی به‌ازای هر بازدیدکننده می‌ذاریم تا یه نفر/بات کل سهمیه رو مصرف نکنه.
const RATE_LIMIT_PER_IP_PER_DAY = 20;
// تحلیل تصویر (vision) چندین برابر چت متنی نورون مصرف می‌کنه، پس سقف جدا و سخت‌گیرانه‌تری داره
const VISION_RATE_LIMIT_PER_IP_PER_DAY = 5;
// درخواست‌های داخلی (مثلاً نویسنده خودکار بلاگ از bytelab-telegram) با این هدر خودشون رو معرفی می‌کنن
// و از محدودیت نرخ عمومی معاف می‌شن. این مقدار باید دقیقاً با هدری که telegram/worker.js می‌فرسته یکی باشه.
const INTERNAL_CALL_SECRET = "bytelab-internal-2026";

async function checkRateLimit(env, ip, kind) {
  // اگه KV وصل نباشه، محدودیت رو نادیده می‌گیریم (fail-open) تا سایت از کار نیفته
  if (!env.RATE_LIMIT_KV || !ip || ip === "unknown") return { ok: true };
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD به وقت UTC
  const key = `ratelimit:${kind}:${ip}:${today}`;
  const limit = kind === "vision" ? VISION_RATE_LIMIT_PER_IP_PER_DAY : RATE_LIMIT_PER_IP_PER_DAY;
  const current = parseInt((await env.RATE_LIMIT_KV.get(key)) || "0", 10);
  if (current >= limit) {
    return { ok: false };
  }
  await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 86400 });
  return { ok: true };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
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

// ------------------------------------------------------------------
// کش کردن اطلاعات سایت با Cache API (بدون نیاز به هیچ تنظیم اضافه)
// ------------------------------------------------------------------
async function getSiteContext(ctx) {
  const cacheKey = new Request(BASE_URL + "/__ai_site_context_cache__");
  const cache = caches.default;

  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return await cached.text();
    }
  } catch (e) {
    // اگه کش در دسترس نبود، بی‌خیال می‌شیم و مستقیم می‌خونیم
  }

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
  const combined = results.filter(Boolean).join("\n\n");

  try {
    const response = new Response(combined, {
      headers: { "Cache-Control": `max-age=${SITE_CONTEXT_CACHE_SECONDS}` },
    });
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(cacheKey, response));
    } else {
      await cache.put(cacheKey, response);
    }
  } catch (e) {
    // کش نشد، مشکلی نیست
  }

  return combined;
}

// ------------------------------------------------------------------
// انتخاب هوشمند مدل: سوالای ساده → مدل سبک، سوالای پیچیده → مدل سنگین
// ------------------------------------------------------------------
function needsHeavyModel(userText) {
  if (!userText) return false;
  const heavySignals = [
    "چرا",
    "مقایسه",
    "تحلیل",
    "برنامه‌ریزی",
    "برنامه ریزی",
    "استراتژی",
    "پیچیده",
    "کد بنویس",
    "دیباگ",
    "طراحی کن",
    "معماری",
  ];
  const isLong = userText.length > 350;
  const hasSignal = heavySignals.some((w) => userText.includes(w));
  return isLong || hasSignal;
}

async function runTextWithFallback(env, aiMessages, maxTokens, preferHeavy) {
  const modelOrder = preferHeavy
    ? [...HEAVY_MODELS, ...LIGHT_MODELS]
    : [...LIGHT_MODELS, ...HEAVY_MODELS];

  let lastError = null;
  const safeMaxTokens = Math.min(
    Math.max(parseInt(maxTokens, 10) || DEFAULT_MAX_TOKENS, 256),
    HARD_MAX_TOKENS
  );
  for (const model of modelOrder) {
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

// تبدیل data URL یا base64 خام به آرایه بایت
function base64ToBytes(base64Input) {
  const clean = base64Input.includes(",") ? base64Input.split(",")[1] : base64Input;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return Array.from(bytes);
}

// ------------------------------------------------------------------
// رفع حلقه‌ی تکرار (دو سطح: n-gram و جمله‌ی کامل) + پاک‌سازی جمله‌ی ناقص آخر
// ------------------------------------------------------------------
function cutRepetition(text) {
  if (!text) return text;

  const words = text.split(/\s+/);
  for (let winSize = 1; winSize <= 8; winSize++) {
    for (let i = 0; i + winSize * 3 <= words.length; i++) {
      const a = words.slice(i, i + winSize).join(" ");
      const b = words.slice(i + winSize, i + 2 * winSize).join(" ");
      const c = words.slice(i + 2 * winSize, i + 3 * winSize).join(" ");
      if (a && a === b && a === c) {
        const cutWords = words.slice(0, i + winSize);
        text = cutWords.join(" ").trim();
        if (!/[.!؟?]$/.test(text)) text += ".";
        break;
      }
    }
  }

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
  const cleaned = finalText || text.slice(0, 300).trim();

  if (cleaned && !/[.!؟?]$/.test(cleaned)) {
    const lastEnd = Math.max(
      cleaned.lastIndexOf("."),
      cleaned.lastIndexOf("!"),
      cleaned.lastIndexOf("؟"),
      cleaned.lastIndexOf("?")
    );
    if (lastEnd > 20) {
      return cleaned.slice(0, lastEnd + 1).trim();
    }
  }
  return cleaned;
}

// ------------------------------------------------------------------
// تحلیل تصویر (با پذیرش خودکار توافق‌نامه در صورت نیاز)
// ------------------------------------------------------------------
async function runVision(env, imageBase64, promptText) {
  const imageBytes = base64ToBytes(imageBase64);

  async function callModel() {
    const result = await env.AI.run(VISION_MODEL, {
      image: imageBytes,
      prompt: promptText,
      max_tokens: 450,
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
    const needsAgreement =
      msg.includes("5016") ||
      msg.toLowerCase().includes("agree") ||
      msg.toLowerCase().includes("license");

    if (!needsAgreement) throw err;

    try {
      await env.AI.run(VISION_MODEL, { prompt: "agree" });
    } catch (agreeErr) {
      throw err;
    }
    return await callModel();
  }
}

function buildVisionPrompt(lastUserText, conversationHint, languageInstruction) {
  return `فقط بر اساس چیزی که واقعاً توی عکس می‌بینی، در حداکثر ۳ جمله کوتاه جواب بده. هیچ کلمه یا جمله‌ای رو تکرار نکن. هیچ برچسب، شماره، یا حرف (مثل الف، ب، ج، ۱، ۲) توی جوابت ننویس؛ فقط متن ساده و روان بنویس.
${languageInstruction ? `\n${languageInstruction}\n` : ""}
راهنمای داخلی (توی جواب نیار، فقط طبق این تصمیم بگیر):
- اگر عکس نشون‌دهنده خطا، پیغام سیستم، یا مشکل نرم‌افزاری/کده: بگو مشکل چیه و راه‌حلش رو بگو.
- اگر عکس یک طرح گرافیکی، رابط کاربری (UI/UX)، یا نمونه‌کار طراحیه: سبک بصری رو توصیف کن و بگو بایت‌لب چه امکانات مشابهی می‌تونه پیاده کنه.
- در غیر این صورت (منظره، خیابون، حیوان، آدم، غذا، یا هر چیز عادی دیگه): فقط صادقانه توصیف کن چی توی عکس هست، بدون هیچ اشاره‌ای به بایت‌لب یا خطای فنی.
${conversationHint ? `\nزمینه‌ی مکالمه‌ی قبلی (برای درک بهتر ادامه‌ی صحبت): ${conversationHint}\n` : ""}
درخواست/پیام کاربر همراه عکس: "${lastUserText}"`;
}

// ------------------------------------------------------------------
// تبدیل صدا به متن (Whisper)
// ------------------------------------------------------------------
async function transcribeAudio(env, audioBase64) {
  const audioBytes = base64ToBytes(audioBase64);
  const result = await env.AI.run(WHISPER_MODEL, { audio: audioBytes });
  if (!result || !result.text) {
    throw new Error("تبدیل صدا به متن ناموفق بود.");
  }
  return result.text.trim();
}

// ------------------------------------------------------------------
// فیلتر پایه‌ی ورودی: طول بیش‌ازحد یا اسپم آشکار
// ------------------------------------------------------------------
function moderateInput(text) {
  if (!text) return { ok: true };
  if (text.length > MAX_USER_MESSAGE_LENGTH) {
    return { ok: false, reason: "پیام شما خیلی طولانیه. لطفاً کوتاه‌ترش کن." };
  }
  // تکرار مشکوک یک کاراکتر/کلمه بیش از ۳۰ بار پشت‌سرهم → احتمال اسپم یا حمله
  if (/(.)\1{30,}/.test(text)) {
    return { ok: false, reason: "پیام شما معتبر به نظر نمی‌رسه، لطفاً واضح بنویس." };
  }
  return { ok: true };
}

// ------------------------------------------------------------------
// چند مثال Few-shot برای ثابت نگه‌داشتن لحن بایت‌لب
// ------------------------------------------------------------------
const FEW_SHOT_EXAMPLES = [
  { role: "user", content: "قیمت طراحی سایت شرکتی چقدره؟" },
  {
    role: "assistant",
    content:
      "قیمت بسته به تعداد صفحات و امکانات فرق می‌کنه. برای یه برآورد دقیق، می‌تونی بگی چند صفحه می‌خوای و چه امکاناتی (فرم تماس، فروشگاه، پنل مدیریت و غیره) مدنظرته تا دقیق‌تر راهنماییت کنم.",
  },
  { role: "user", content: "اپلیکیشن اندروید هم طراحی می‌کنید؟" },
  {
    role: "assistant",
    content:
      "بله، طراحی و توسعه اپ اندروید هم جزو خدمات بایت‌لبه. بسته به این‌که اپت قراره چیکار کنه (فروشگاهی، مدیریتی، شبکه اجتماعی...) رویکرد فرق می‌کنه. می‌تونی بیشتر درباره ایده‌ات بگی؟",
  },
];

// ------------------------------------------------------------------
// تشخیص زبان پیام کاربر (فارسی/عربی در برابر لاتین) و ساخت دستور صریح زبان
// ------------------------------------------------------------------
function detectLanguageInstruction(text) {
  if (!text) return "";
  const persianCount = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;

  if (latinCount > persianCount && latinCount >= 4) {
    return "کاربر پیامش رو به انگلیسی نوشته. حتماً جواب رو کامل و روان به زبان انگلیسی بده، نه فارسی.";
  }
  return "کاربر به فارسی نوشته. جواب رو به فارسی روان بده.";
}

// ------------------------------------------------------------------
// خلاصه‌سازی مکالمه‌های طولانی قبل از فرستادن به مدل (صرفه‌جویی توکن)
// ------------------------------------------------------------------
const CONVERSATION_SUMMARY_THRESHOLD = 10; // بیشتر از این تعداد پیام → خلاصه می‌شه
const CONVERSATION_KEEP_RECENT = 6; // این تعداد پیام آخر همیشه کامل نگه داشته می‌شه

async function condenseConversation(env, messages) {
  if (!messages || messages.length <= CONVERSATION_SUMMARY_THRESHOLD) {
    return messages;
  }
  const older = messages.slice(0, messages.length - CONVERSATION_KEEP_RECENT);
  const recent = messages.slice(messages.length - CONVERSATION_KEEP_RECENT);

  const olderText = older
    .map((m) => `${m.role === "user" ? "کاربر" : "دستیار"}: ${m.content}`)
    .join("\n")
    .slice(0, 6000);

  try {
    const summaryMessages = [
      {
        role: "system",
        content:
          "متن مکالمه‌ی زیر رو در حداکثر ۴-۵ جمله‌ی فارسی خلاصه کن. فقط نکات مهم، خواسته‌ها و تصمیمات کاربر رو نگه دار، جزئیات کم‌اهمیت رو حذف کن.",
      },
      { role: "user", content: olderText },
    ];
    const result = await env.AI.run(LIGHT_MODELS[0], {
      messages: summaryMessages,
      max_tokens: 300,
    });
    const summary = result && result.response ? result.response.trim() : "";
    if (!summary) return messages;
    return [
      { role: "system", content: `خلاصه‌ی بخش قبلی مکالمه: ${summary}` },
      ...recent,
    ];
  } catch (e) {
    // اگه خلاصه‌سازی شکست خورد، همون مکالمه‌ی کامل رو بفرست (fail-safe)
    return messages;
  }
}


function buildSuggestedActions(responseText, isVision) {
  if (isVision) {
    return ["یه اسکرین‌شات دیگه بفرستم؟", "راه‌حل جایگزین هم هست؟", "هزینه‌ی رفعش چقدره؟"];
  }
  const t = responseText || "";
  if (/قیمت|هزینه|تومان/.test(t)) {
    return ["جزئیات بیشتر قیمت", "می‌خوام سفارش بدم", "با پشتیبانی صحبت کنم"];
  }
  if (/خطا|مشکل|باگ/.test(t)) {
    return ["اسکرین‌شات بفرستم؟", "راه‌حل دیگه‌ای هست؟"];
  }
  return ["بیشتر توضیح بده", "نمونه‌کار ببینم", "با بایت‌لب تماس بگیرم"];
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // ---- تست سلامت سرویس ----
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

    // ---- محدودیت نرخ عمومی (فقط برای درخواست‌های واقعی از سایت، نه تماس‌های داخلی) ----
    const isInternalCall = request.headers.get("X-Bytelab-Internal") === INTERNAL_CALL_SECRET;
    if (!isInternalCall) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rl = await checkRateLimit(env, ip, "chat");
      if (!rl.ok) {
        return jsonResponse(
          {
            error:
              "امروز به سقف پیام‌های رایگان چت رسیدی. لطفاً فردا دوباره امتحان کن، یا برای پاسخ فوری مستقیم با بایت‌لب در تماس باش.",
          },
          429,
          cors
        );
      }
    }

    try {
      const body = await request.json();
      const { system, messages, image, images, audio, max_tokens, prefer_heavy } = body;

      // ---- اگه صدا فرستاده شده، اول تبدیلش کن به متن ----
      let effectiveMessages = messages || [];
      let transcribedText = null;
      if (audio) {
        try {
          transcribedText = await transcribeAudio(env, audio);
          effectiveMessages = [...effectiveMessages, { role: "user", content: transcribedText }];
        } catch (audioErr) {
          return jsonResponse(
            { error: "خطا در تبدیل صدا به متن: " + (audioErr.message || String(audioErr)) },
            500,
            cors
          );
        }
      }

      const lastUserText =
        effectiveMessages && effectiveMessages.length
          ? effectiveMessages[effectiveMessages.length - 1].content
          : "";

      // ---- فیلتر پایه‌ی ورودی ----
      const modCheck = moderateInput(lastUserText);
      if (!modCheck.ok) {
        return jsonResponse({ error: modCheck.reason }, 400, cors);
      }

      const siteContext = await getSiteContext(ctx);
      const languageInstruction = detectLanguageInstruction(lastUserText);

      const fullSystem = `${system || ""}

===== اطلاعات زنده سایت بایت‌لب (چند صفحه، تازه‌خوانی‌شده) =====
${siteContext}
===== پایان اطلاعات سایت =====
اگه مناسب بود، از فرمت لیستی/مارک‌داون ساده برای خوانایی بهتر استفاده کن.
${languageInstruction}`;

      // ---- حالت تصویر: تک عکس یا چند عکس ----
      const imageList = images && Array.isArray(images) ? images : image ? [image] : [];

      if (imageList.length > 0) {
        if (!isInternalCall) {
          const ip = request.headers.get("CF-Connecting-IP") || "unknown";
          const visionRl = await checkRateLimit(env, ip, "vision");
          if (!visionRl.ok) {
            return jsonResponse(
              {
                error:
                  "امروز به سقف تحلیل تصویر رایگان رسیدی (این قابلیت گرون‌تر از چت متنیه). لطفاً فردا دوباره امتحان کن یا سوالت رو متنی بپرس.",
              },
              429,
              cors
            );
          }
        }

        if (imageList.length > MAX_IMAGES_PER_REQUEST) {
          return jsonResponse(
            { error: `حداکثر ${MAX_IMAGES_PER_REQUEST} عکس در هر درخواست مجازه.` },
            400,
            cors
          );
        }
        for (const img of imageList) {
          if (typeof img === "string" && img.length > MAX_IMAGE_BASE64_LENGTH) {
            return jsonResponse(
              { error: "حجم عکس خیلی زیاده. لطفاً عکس کوچک‌تری بفرست." },
              400,
              cors
            );
          }
        }

        const conversationHint =
          effectiveMessages.length > 1
            ? effectiveMessages
                .slice(-4, -1)
                .map((m) => `${m.role === "user" ? "کاربر" : "دستیار"}: ${String(m.content).slice(0, 150)}`)
                .join(" | ")
            : "";

        const visionPrompt = buildVisionPrompt(
          lastUserText || "این تصویر رو بررسی کن.",
          conversationHint,
          languageInstruction
        );

        try {
          const visionResponses = [];
          for (const img of imageList) {
            const r = await runVision(env, img, visionPrompt);
            visionResponses.push(r);
          }
          const combinedText =
            imageList.length === 1
              ? visionResponses[0]
              : visionResponses.map((r, i) => `تصویر ${i + 1}: ${r}`).join("\n\n");

          return jsonResponse(
            {
              content: [{ type: "text", text: combinedText }],
              suggested_actions: buildSuggestedActions(combinedText, true),
              _debug_model: VISION_MODEL,
            },
            200,
            cors
          );
        } catch (visionErr) {
          return jsonResponse(
            {
              error:
                "متأسفانه الان امکان تحلیل تصویر نیست. یه لحظه دیگه دوباره امتحان کن، یا سوالت رو به‌صورت متنی بپرس.",
            },
            500,
            cors
          );
        }
      }

      // ---- حالت معمولی: متن ----
      const condensedMessages = await condenseConversation(env, effectiveMessages);
      const aiMessages = [
        { role: "system", content: fullSystem },
        ...FEW_SHOT_EXAMPLES,
        ...condensedMessages.map((m) => ({ role: m.role, content: m.content })),
      ];

      const preferHeavy = prefer_heavy === true || needsHeavyModel(lastUserText);

      try {
        const { response, modelUsed } = await runTextWithFallback(
          env,
          aiMessages,
          max_tokens,
          preferHeavy
        );

        return jsonResponse(
          {
            content: [{ type: "text", text: response || "پاسخی دریافت نشد." }],
            suggested_actions: buildSuggestedActions(response, false),
            transcribed_text: transcribedText,
            _debug_model: modelUsed,
          },
          200,
          cors
        );
      } catch (allModelsErr) {
        const errMsg = String((allModelsErr && allModelsErr.message) || allModelsErr || "");
        console.error("bytelab-ai: هر دو مدل شکست خوردند:", errMsg);
        const isQuotaExceeded =
          errMsg.includes("4006") || errMsg.toLowerCase().includes("daily free allocation");
        return jsonResponse(
          {
            error: isQuotaExceeded
              ? "سهمیه رایگان هوش‌مصنوعی امروز تموم شده (ریست می‌شه ساعت ۰۰:۰۰ UTC / ۳:۳۰ بامداد ایران). لطفاً تا اون‌موقع صبر کن."
              : "الان سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً چند دقیقه دیگه دوباره امتحان کن.",
          },
          503,
          cors
        );
      }
    } catch (err) {
      return jsonResponse(
        { error: "خطا: " + (err && err.message ? err.message : String(err)) },
        500,
        cors
      );
    }
  },
};
