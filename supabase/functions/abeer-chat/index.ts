// Edge function: proxy to NVIDIA Build chat completions
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-20b";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("NVIDIA_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "NVIDIA_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { messages, system, model, temperature, max_tokens } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "messages array is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const payload = {
      model: model || DEFAULT_MODEL,
      temperature: typeof temperature === "number" ? temperature : 0.2,
      max_tokens: typeof max_tokens === "number" ? max_tokens : 600,
      stream: false,
      messages: [
        ...(system ? [{ role: "system", content: String(system) }] : []),
        ...messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: String(m.content ?? ""),
        })),
      ],
    };

    const res = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("NVIDIA error", res.status, text.slice(0, 500));
      return new Response(
        JSON.stringify({ error: `NVIDIA ${res.status}`, detail: text.slice(0, 500) }),
        { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON from NVIDIA", raw: text.slice(0, 500) }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Some NVIDIA models (e.g. gpt-oss) split output into reasoning + content.
    // We must NEVER show the reasoning ("thinking") or the system prompt to
    // the user. If we can't extract a clean Arabic answer, return a friendly
    // fallback in Abir's voice instead.
    // @ts-ignore
    const choice = data?.choices?.[0]?.message;

    const PROMPT_MARKERS = [
      "أنتِ الصوت الرقمي",
      "قواعد صارمة",
      "── أسئلة مجانية ──",
      "── مواضيع مدفوعة",
      "أجيبي من قاعدة البيانات",
    ];
    // English "thinking" / meta-reasoning markers the model sometimes leaks.
    const THINKING_MARKERS = [
      "We need to",
      "We must",
      "According to the rules",
      "The user says",
      "The user:",
      "Let's search",
      "Let us search",
      "We should",
      "That is #",
      "The answer:",
    ];

    const hasArabic = (s: string) => /[\u0600-\u06FF]/.test(s);
    const looksLikeThinking = (s: string) =>
      THINKING_MARKERS.some((m) => s.includes(m));
    const looksLikePrompt = (s: string) =>
      PROMPT_MARKERS.some((m) => s.includes(m));

    // Extract the last clean Arabic paragraph (no English thinking, no prompt
    // markers). Splits on blank lines.
    const extractArabicAnswer = (raw?: string): string => {
      const t = (raw ?? "").trim();
      if (!t) return "";
      const blocks = t
        .split(/\n\s*\n+/)
        .map((b) => b.trim())
        .filter(Boolean);
      // Walk from the end — the actual answer usually comes last.
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (looksLikePrompt(b)) continue;
        if (looksLikeThinking(b)) continue;
        if (!isArabic(b)) continue;
        // Strip leading labels like "Answer:" / "الجواب:" etc.
        return b.replace(/^(answer|الجواب|الرد)\s*[:：-]\s*/i, "").trim();
      }
      return "";
    };

    // Only trust `content`. Never surface reasoning_content to the user.
    let reply = extractArabicAnswer(choice?.content);
    if (!reply) {
      // Last resort: try reasoning fields, but ONLY if they contain a clean
      // Arabic tail with no thinking/prompt leakage.
      reply =
        extractArabicAnswer(choice?.reasoning_content) ||
        extractArabicAnswer(choice?.reasoning) ||
        "";
    }
    if (!reply) {
      reply =
        "سامحيني حبيبتي، ما قدرت أصيغ الجواب هلق. جربي تعيدي صياغة سؤالك بكلمات أوضح.";
    }

    return new Response(JSON.stringify({ reply, raw: data }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("abeer-chat error", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
