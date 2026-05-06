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
    // If content is empty, fall back to reasoning_content so we never return blank.
    // @ts-ignore
    const choice = data?.choices?.[0]?.message;

    // Detect when the model echoes the system prompt back instead of answering.
    // Markers come from buildPrompt() in the frontend.
    const PROMPT_MARKERS = [
      "أنتِ الصوت الرقمي",
      "قواعد صارمة",
      "── أسئلة مجانية ──",
      "── مواضيع مدفوعة",
      "أجيبي من قاعدة البيانات",
    ];
    const looksLikePrompt = (s: string) => {
      if (!s) return false;
      const head = s.slice(0, 400);
      return PROMPT_MARKERS.some((m) => head.includes(m));
    };
    const stripPromptEcho = (s: string) => {
      if (!s) return "";
      // If the model concatenated prompt + answer, try to keep only the tail
      // after the last prompt marker.
      let out = s;
      for (const m of PROMPT_MARKERS) {
        const idx = out.lastIndexOf(m);
        if (idx !== -1) {
          // jump past the marker line
          const nl = out.indexOf("\n", idx);
          out = nl !== -1 ? out.slice(nl + 1) : "";
        }
      }
      return out.trim();
    };

    const pickClean = (raw?: string) => {
      const t = (raw ?? "").trim();
      if (!t) return "";
      if (looksLikePrompt(t)) {
        const cleaned = stripPromptEcho(t);
        return looksLikePrompt(cleaned) ? "" : cleaned;
      }
      return t;
    };

    const reply =
      pickClean(choice?.content) ||
      pickClean(choice?.reasoning_content) ||
      pickClean(choice?.reasoning) ||
      "";

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
