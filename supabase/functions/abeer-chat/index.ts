// Edge function: proxy to NVIDIA Build chat completions
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-20b";

const OUT_OF_SCOPE =
  "هالسؤال مو من اختصاصي وما لقيت جواب إلو بقاعدة بياناتي حبيبتي 💛 جربي تسأليني بموضوع تاني.";

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

    // Extract a clean Arabic answer. We strip lines that are clearly English
    // thinking or prompt echoes, then keep only Arabic-bearing lines.
    const extractArabicAnswer = (raw?: string): string => {
      const t = (raw ?? "").trim();
      if (!t) return "";
      const lines = t.split(/\r?\n/);
      const kept: string[] = [];
      for (const ln of lines) {
        const s = ln.trim();
        if (!s) {
          if (kept.length && kept[kept.length - 1] !== "") kept.push("");
          continue;
        }
        if (looksLikePrompt(s)) continue;
        if (looksLikeThinking(s)) continue;
        if (!hasArabic(s)) continue;
        kept.push(s);
      }
      const out = kept.join("\n").trim();
      if (!out) return "";
      return out.replace(/^(answer|الجواب|الرد)\s*[:：-]\s*/i, "").trim();
    };

    const callNvidia = async (extraSystem?: string) => {
      const p = {
        ...payload,
        messages: extraSystem
          ? [{ role: "system", content: extraSystem }, ...payload.messages]
          : payload.messages,
      };
      const r = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(p),
      });
      const tx = await r.text();
      if (!r.ok) return null;
      try { return JSON.parse(tx); } catch { return null; }
    };

    let reply =
      extractArabicAnswer(choice?.content) ||
      extractArabicAnswer(choice?.reasoning_content) ||
      extractArabicAnswer(choice?.reasoning) ||
      "";

    // Retry once with a strict Arabic-only nudge if first pass was unusable.
    if (!reply) {
      const retry = await callNvidia(
        "جاوبي بالعربي فقط، على الأقل ٣ جمل مع شرح بسيط وواضح بدون حشو، بدون أي تفكير بصوت عالي وبدون إنجليزي وبدون تكرار التعليمات. اختمي دائماً بسؤال قيادي قصير مرتبط بالجواب يخلّي العميلة تتعمّق بحالتها. إذا صار عدد ردودك السابقة بالمحادثة ٣ أو أكثر، أضيفي بعد السؤال القيادي جملة دفع لطيفة وحازمة قريبة من: \"إذن أنتِ في حاجة إلى جلسة استشارة خاصة أو ديكودنغ لفك شيفرة الوضعية التي تخصك\" مع تنويع الصياغة. إذا سألت العميلة عن السعر أو التكلفة، اذكري دائماً أن السعر 299$. إذا السؤال مو من اختصاصك أو مو موجود بقاعدة بياناتك، ردي بالعربي إنه خارج اختصاصك.",
      );
      // @ts-ignore
      const c2 = retry?.choices?.[0]?.message;
      reply =
        extractArabicAnswer(c2?.content) ||
        extractArabicAnswer(c2?.reasoning_content) ||
        extractArabicAnswer(c2?.reasoning) ||
        "";
    }

    if (!reply) reply = OUT_OF_SCOPE;

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
