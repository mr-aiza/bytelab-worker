// آدرس واقعی صفحه اصلی سایتت — اگه دامنه یا مسیرش عوض شد، همینجا آپدیتش کن
const SITE_URL = "https://mr-aiza.github.io/bytelab/index.html";

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

      // مدل رایگان روی زیرساخت خود Cloudflare (بدون کلید، بدون هزینه)
      const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: aiMessages,
      });

      // خروجی را در همان قالبی که chat.html انتظار دارد برمی‌گردانیم
      const wrapped = {
        content: [{ type: "text", text: result.response || "پاسخی دریافت نشد." }],
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
