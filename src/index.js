// آدرس واقعی صفحه اصلی سایتت — اگه دامنه یا مسیرش عوض شد، همینجا آپدیتش کن
const SITE_URL = "https://mr-aiza.github.io/bytelab/index.html";

// لیست مدل‌ها به ترتیب اولویت. اول مدل سبک‌تر (نرون کمتر) امتحان می‌شه؛
// اگه خطا داد یا جواب خالی برگردوند، میره سراغ مدل سنگین‌تر به‌عنوان fallback.
const MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
];

function stripHtml(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getSiteContext(){
  try{
    const res = await fetch(SITE_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    const html = await res.text();
    const text = stripHtml(html);
    return text.slice(0, 3000); // کاهش طول برای مصرف کمتر نرون
  }catch(e){
    return "";
  }
}

// امتحان کردن مدل‌ها یکی‌یکی تا یکی جواب بده
async function runWithFallback(env, aiMessages){
  let lastError = null;
  for (const model of MODELS) {
    try {
      const result = await env.AI.run(model, { messages: aiMessages });
      if (result && result.response) {
        return { response: result.response, modelUsed: model };
      }
      lastError = new Error(`مدل ${model} پاسخ خالی برگرداند.`);
    } catch (err) {
      lastError = err;
      // برو سراغ مدل بعدی
      continue;
    }
  }
  throw lastError || new Error("همه مدل‌ها شکست خوردند.");
}

// رمز ساده برای دیدن لیست تیکت‌ها — این رو عوض کن به یه چیز فقط خودت بدونی!
const ADMIN_KEY = "8657";

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ===== ثبت تیکت جدید =====
    if (url.pathname === "/ticket" && request.method === "POST") {
      try {
        const { name, contact, subject, message } = await request.json();
        if (!message || !message.trim()) {
          return new Response(JSON.stringify({ error: "پیام خالی است." }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        const ticket = {
          id,
          name: name || "ناشناس",
          contact: contact || "",
          subject: subject || "بدون موضوع",
          message,
          createdAt: new Date().toISOString(),
          status: "open",
        };
        await env.TICKETS_KV.put("ticket:" + id, JSON.stringify(ticket));
        return new Response(JSON.stringify({ ok: true, id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "خطا: " + (err && err.message ? err.message : String(err)) }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ===== دیدن لیست تیکت‌ها (فقط با رمز مدیریتی) =====
    if (url.pathname === "/tickets" && request.method === "GET") {
      const key = url.searchParams.get("key");
      if (key !== ADMIN_KEY) {
        return new Response("دسترسی غیرمجاز — رمز اشتباه است.", {
          status: 401, headers: corsHeaders,
        });
      }
      const list = await env.TICKETS_KV.list({ prefix: "ticket:" });
      const tickets = [];
      for (const k of list.keys) {
        const val = await env.TICKETS_KV.get(k.name);
        if (val) tickets.push(JSON.parse(val));
      }
      tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return new Response(JSON.stringify(tickets, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
      });
    }

    // حالت دیباگ: وقتی مستقیم توی مرورگر (GET) باز بشه، یه تست ساده به AI می‌زنیم
    // و خطای واقعی رو به‌صورت متنی نشون می‌دیم تا بدون DevTools هم بشه دیباگ کرد.
    if (request.method === "GET") {
      try {
        const testMessages = [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "بگو 'سلام، من فعالم'" },
        ];
        const { response, modelUsed } = await runWithFallback(env, testMessages);
        return new Response(
          "✅ همه‌چیز سالمه!\nمدل استفاده‌شده: " + modelUsed + "\nجواب: " + response,
          { headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(
          "❌ خطا در تماس با AI:\n" + (err && err.message ? err.message : String(err)) +
          "\n\nStack:\n" + (err && err.stack ? err.stack : "ندارد"),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
      const { system, messages } = await request.json();

      const siteContext = await getSiteContext();

      const fullSystem = `${system}

===== اطلاعات زنده سایت بایت‌لب (تازه‌خوانی‌شده از خود سایت) =====
${siteContext}
===== پایان اطلاعات سایت =====`;

      // تبدیل پیام‌ها به فرمتی که Workers AI می‌فهمد
      const aiMessages = [
        { role: "system", content: fullSystem },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ];

      // امتحان کردن مدل‌ها با fallback خودکار
      const { response, modelUsed } = await runWithFallback(env, aiMessages);

      // خروجی را در همان قالبی که chat.html انتظار دارد برمی‌گردانیم
      const wrapped = {
        content: [{ type: "text", text: response || "پاسخی دریافت نشد." }],
        _debug_model: modelUsed, // برای دیباگ؛ اگه نخواستی می‌تونی حذفش کنی
      };

      return new Response(JSON.stringify(wrapped), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "خطا: " + (err && err.message ? err.message : String(err)) }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};
