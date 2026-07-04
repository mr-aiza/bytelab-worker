// آدرس واقعی صفحه اصلی سایتت — اگه دامنه یا مسیرش عوض شد، همینجا آپدیتش کن
const SITE_URL = "https://mr-aiza.github.io/bytelab/index.html";

// لیست مدل‌ها به ترتیب اولویت. اگه اولی خطا داد یا در دسترس نبود، میره سراغ بعدی.
const MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fast",
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
    return text.slice(0, 8000); // جلوگیری از پرامپت بیش‌ازحد بزرگ
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

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
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
