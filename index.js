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

      // تبدیل پیام‌ها به فرمتی که Workers AI می‌فهمد
      const aiMessages = [
        { role: "system", content: system },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ];

      // مدل رایگان روی زیرساخت خود Cloudflare (بدون کلید، بدون هزینه)
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
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
