import { useState, useEffect, useRef, useCallback, forwardRef } from "react";
import Papa from "papaparse";
import bundledCsv from "@/assets/abeer-qa.csv?raw";
import abeerAvatar from "@/assets/abeer-avatar.jpg";
import { supabase } from "@/integrations/supabase/client";

// ── DEVELOPER CONFIG ─────────────────────────────────────────────────────────
// Optional: set to a published Google Sheet CSV URL
// (File → Share → Publish to web → CSV → /pub?output=csv)
const SHEET_CSV_URL = "";
const REFRESH_MS = 60 * 60 * 1000;

const AVATAR_URL = abeerAvatar;
const COURSE_URL = "https://www.abirlogic.com/decoding";

// ── Types ────────────────────────────────────────────────────────────────────
type Row = { q: string; a: string; t: string };
type Msg = { role: "user" | "assistant"; content: string; paid?: boolean; teaser?: string };

// ── Paid-topic detection ─────────────────────────────────────────────────────
// Arabic-aware normalization: strip diacritics, unify alef/ya/ta-marbuta,
// drop tatweel & punctuation, collapse whitespace.
function normalizeAr(s: string): string {
  return s
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // diacritics + tatweel
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Arabic stopwords to ignore when token-matching
const AR_STOP = new Set([
  "في", "من", "الى", "على", "عن", "مع", "هو", "هي", "انا", "انت", "هذا",
  "هذه", "ذلك", "تلك", "كيف", "ماذا", "متى", "اين", "لماذا", "ليش", "شو",
  "ما", "لا", "نعم", "ان", "او", "ثم", "كان", "يكون", "كل", "بعض", "كثير",
  "اكثر", "اقل", "جدا", "ايضا", "ولكن", "لكن", "حتى", "قد", "عند", "بعد",
  "قبل", "اذا", "لو", "هل", "بس", "يعني",
]);

function tokens(s: string): string[] {
  return normalizeAr(s)
    .split(" ")
    .filter((t) => t.length >= 3 && !AR_STOP.has(t));
}

// Returns the best-matching paid row, or null. Trigger only if a paid row
// scores meaningfully AND beats any free-row match.
function findPaidMatch(userQuestion: string, rows: Row[]): Row | null {
  if (!rows.length) return null;
  const qTokens = new Set(tokens(userQuestion));
  if (qTokens.size === 0) return null;

  let bestPaidScore = 0;
  let bestPaidRow: Row | null = null;
  let bestFree = 0;
  for (const r of rows) {
    const rTokens = tokens(r.q);
    if (!rTokens.length) continue;
    let overlap = 0;
    for (const t of rTokens) if (qTokens.has(t)) overlap++;
    const score = overlap / Math.max(rTokens.length, 3);
    if (r.t === "مدفوع") {
      if (score > bestPaidScore) {
        bestPaidScore = score;
        bestPaidRow = r;
      }
    } else if (score > bestFree) {
      bestFree = score;
    }
  }
  if (bestPaidScore >= 0.34 && bestPaidScore > bestFree) return bestPaidRow;
  return null;
}

// Take roughly the first ~20% of words (min 6, max 18) as a teaser.
function teaserFromAnswer(answer: string): string {
  const words = answer.split(/\s+/).filter(Boolean);
  const take = Math.min(18, Math.max(6, Math.ceil(words.length * 0.2)));
  return words.slice(0, take).join(" ");
}


// ── CSV ──────────────────────────────────────────────────────────────────────
function parseSheet(csv: string): Row[] {
  const { data } = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  return data
    .filter((r) => r["سؤال العميل"] && r["جواب"] && r["نوع السؤال"])
    .map((r) => ({
      q: r["سؤال العميل"].trim(),
      a: r["جواب"].trim(),
      t: r["نوع السؤال"].trim(),
    }));
}

// ── System prompt ────────────────────────────────────────────────────────────
function buildPrompt(rows: Row[]) {
  const free = rows.filter((r) => r.t === "مجاني");
  const paid = rows.filter((r) => r.t === "مدفوع");
  const freeBlock = free
    .map((r, i) => `[${i + 1}] س: ${r.q}\nج: ${r.a}`)
    .join("\n\n");
  const paidBlock = paid.map((r, i) => `[${i + 1}] ${r.q}`).join("\n");
  return (
    "أنتِ الصوت الرقمي لعبير الرفاعي — تتحدثين بأسلوبها وفلسفتها بالضبط.\n\n" +
    "قواعد صارمة:\n" +
    "١. أجيبي من قاعدة البيانات فقط — لا تخترعي.\n" +
    "٢. مجاني → أجيبي بالكامل بنبرة عبير الحازمة السيادية.\n" +
    "٣. مدفوع → شوّقي فقط دون كشف الجواب، وجهيها لحجز جلسة الديكودنغ.\n" +
    "٤. خارج القاعدة → وجهي للجلسة الشخصية على abirlogic.com\n" +
    "٥. لا تقولي أنا بوت — أنتِ صوت عبير الرقمي.\n" +
    "٦. الطول: ٣ جمل قصيرة كحد أقصى، مختصرة وحازمة، بدون حشو ولا مقدمات ولا خاتمات ولا تعداد.\n" +
    "٧. استخدمي مصطلحات عبير: مصفوفة، كود، رندرة، سيادة، نور عمودي، إزاحة، ديكودنغ.\n" +
    "٨. تكيّفي مع لهجة العميلة (شامي / خليجي / فصحى).\n" +
    "٩. إذا سألت العميلة عن السعر أو التكلفة أو كم يكلّف أي شي (جلسة، كورس، ديكودنغ، إلخ)، اذكري دائماً أن السعر هو 299$.\n" +
    "١٠. عُدّي رسائل العميلة السابقة. لأول سؤالين (السؤال ١ والسؤال ٢) جاوبي فقط بدون أي سؤال قيادي. ابتداءً من السؤال الثالث للعميلة وما بعده، اختمي دائماً بسؤال قيادي قصير ومرتبط بالجواب والسياق، يخلّيها تتعمّق بحالتها. نوّعي الصياغة كل مرة، ولا تبدئي أبداً بـ \"شو أكتر شي\" أو \"شو أكثر شيء\"؛ استخدمي بدائل: كيف، ليش، متى، وين، إيش اللي، شو اللي بيمنعك، شو اللي بيحرّك، شو الإحساس اللي…\n" +
    "١١. ابتداءً من السؤال الرابع للعميلة وما بعده، أضيفي بعد السؤال القيادي جملة دفع حازمة قريبة من: \"إذن أنتِ في حاجة إلى جلسة استشارة خاصة أو ديكودنغ لفك شيفرة الوضعية التي تخصك.\" نوّعي بالصياغة كل مرة بدون تكرار حرفي.\n\n" +
    "── أسئلة مجانية ──\n" +
    freeBlock +
    "\n\n── مواضيع مدفوعة (شوّقي فقط) ──\n" +
    paidBlock
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;900&display=swap');
  :root {
    --purple:      #5B3DA5;
    --purple-deep: #3D2775;
    --purple-soft: #7B5BC4;
    --purple-pale: #F0EBF9;
    --purple-mist: #EAE3F7;
    --gold:        #E8B84B;
    --bg:          #F7F5FC;
    --white:       #FFFFFF;
    --border:      #DDD5F0;
    --text:        #1C1130;
    --text-dim:    #6B5B8E;
    --text-muted:  #A896C8;
    --font:        'Tajawal', sans-serif;
  }
  .abeer-root, .abeer-root * { box-sizing: border-box; }
  .abeer-root { font-family: var(--font); }
  .abeer-scroll::-webkit-scrollbar { width: 4px; }
  .abeer-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  @keyframes abeerFadeUp { from { opacity: 0; transform: translateY(8px);} to {opacity:1; transform:translateY(0);} }
  @keyframes abeerBlink { 0%,80%,100%{transform:scale(0.55);opacity:.35} 40%{transform:scale(1);opacity:1} }
  @keyframes abeerGreen { 0%,100%{opacity:.55} 50%{opacity:1} }
  .abeer-enter { animation: abeerFadeUp .28s ease forwards; }
  .abeer-dot { width:7px; height:7px; border-radius:50%; background: var(--purple-soft); display:inline-block; margin:0 2px; }
  .abeer-dot:nth-child(1){ animation: abeerBlink 1.3s ease-in-out infinite 0s; }
  .abeer-dot:nth-child(2){ animation: abeerBlink 1.3s ease-in-out infinite .18s; }
  .abeer-dot:nth-child(3){ animation: abeerBlink 1.3s ease-in-out infinite .36s; }
  .abeer-sendbtn { transition: transform .15s ease; }
  .abeer-sendbtn:hover:not(:disabled){ transform: scale(1.07); }
  .abeer-sendbtn:active:not(:disabled){ transform: scale(.94); }
  .abeer-chip { transition: all .2s ease; cursor: pointer; }
  .abeer-chip:hover { background: var(--purple-mist); border-color: var(--purple-soft); color: var(--purple); }
  .abeer-online::after {
    content:""; display:inline-block; width:7px; height:7px; border-radius:50%;
    background:#22C55E; margin-inline-start:6px; animation: abeerGreen 1.6s ease-in-out infinite;
  }
  .abeer-textarea { outline:none; resize:none; border:none; background:transparent; width:100%;
    font-family: var(--font); font-size: 14px; color: var(--text); line-height: 1.6; max-height: 130px; }
  .abeer-textarea::placeholder { color: var(--text-muted); }
  .abeer-cta { transition: transform .18s ease, box-shadow .18s ease; }
  .abeer-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(91,61,165,.42) !important; }
  .abeer-cta:active { transform: translateY(0); }
  .abeer-blurred {
    filter: blur(5px);
    user-select: none;
    pointer-events: none;
    color: var(--text-dim);
    -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,.3) 100%);
            mask-image: linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,.3) 100%);
  }
`;

// ── Sub-components (forwardRef to silence ref warnings) ─────────────────────
const Avatar = forwardRef<HTMLDivElement, { size?: number }>(
  function Avatar({ size = 38 }, ref) {
    const border = size > 50 ? 3 : 2;
    return (
      <div
        ref={ref}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #5B3DA5, #3D2775)",
          border: `${border}px solid #fff`,
          boxShadow: "0 2px 10px rgba(91,61,165,.25)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontWeight: 700,
          fontSize: size * 0.42,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <img
          src={AVATAR_URL}
          alt="عبير"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
    );
  }
);

const SendIcon = forwardRef<SVGSVGElement>(function SendIcon(_, ref) {
  return (
    <svg ref={ref} width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 11.5L21 3l-8.5 18-2-8.5L3 11.5z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
});

const CHIPS = [
  "كيف أغير واقعي وأصير شخصاً مؤثراً؟",
  "ليش الناس حولي يستنزفون طاقتي؟",
  "شو هو اختبار الديكودنغ وكيف يساعدني؟",
];

function Welcome({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div
      className="abeer-enter"
      style={{
        textAlign: "center",
        padding: "12px 12px",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
        <Avatar size={64} />
      </div>
      <h2 style={{ fontSize: 19, fontWeight: 800, color: "var(--text)", margin: 0 }}>
        عبير الرفاعي
      </h2>
      <div style={{ fontSize: 12, color: "var(--purple)", marginTop: 3, fontWeight: 500 }}>
        مساعدتي الرقمية — اسأليني بحرية ✦
      </div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8, marginBottom: 0, lineHeight: 1.6 }}>
        سواء عن الصحة، الطاقة، العلاقات، أو السيادة — أنا هنا.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 14 }}>
        {CHIPS.map((q) => (
          <button
            key={q}
            className="abeer-chip"
            onClick={() => onAsk(q)}
            style={{
              border: "1px solid var(--border)",
              background: "var(--white)",
              color: "var(--text-dim)",
              padding: "9px 12px",
              borderRadius: 11,
              fontFamily: "var(--font)",
              fontSize: 12.5,
              textAlign: "right",
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function AbeerChat() {
  const [qaData, setQaData] = useState<Row[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height =
      Math.min(textareaRef.current.scrollHeight, 130) + "px";
  }, [input]);

  // Bundled CSV on mount
  useEffect(() => {
    const rows = parseSheet(bundledCsv);
    if (rows.length) setQaData(rows);
  }, []);

  // Optional live refresh
  const fetchSheet = useCallback(() => {
    if (!SHEET_CSV_URL) return;
    fetch(SHEET_CSV_URL)
      .then((r) => r.text())
      .then((text) => {
        const rows = parseSheet(text);
        if (rows.length) setQaData(rows);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!SHEET_CSV_URL) return;
    fetchSheet();
    const id = setInterval(fetchSheet, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchSheet]);

  const sendMessage = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text || isStreaming) return;

      const history: Msg[] = [...messages, { role: "user", content: text }];
      setMessages(history);
      setInput("");
      setIsStreaming(true);

      const system =
        qaData.length > 0
          ? buildPrompt(qaData)
          : "أنتِ صوت عبير الرفاعي الرقمي. وجهي العميلة لحجز جلسة ديكودنغ على abirlogic.com";

      try {
        const { data, error } = await supabase.functions.invoke("abeer-chat", {
          body: {
            system,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          },
        });

        if (error) throw error;

        const replyRaw = (data as { reply?: string })?.reply?.trim() || "";
        const paidRow = findPaidMatch(text, qaData);
        const userMsgCount = history.filter((m) => m.role === "user").length;
        const forceUpsell = userMsgCount >= 8;

        if (paidRow || forceUpsell) {
          // Paid topic → tease using the real CSV answer (deterministic),
          // ignore the model output to keep the upsell tight.
          const teaser = paidRow ? teaserFromAnswer(paidRow.a) : "";
          const content = paidRow ? paidRow.a : (replyRaw || "");
          setMessages((p) => [
            ...p,
            { role: "assistant", content, teaser, paid: true },
          ]);
        } else {
          const reply = replyRaw || "حدث خطأ. حاولي مرة أخرى.";
          setMessages((p) => [...p, { role: "assistant", content: reply }]);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((p) => [
          ...p,
          {
            role: "assistant",
            content: "تعذر الاتصال بالخادم. حاولي مجدداً.\n" + msg,
          },
        ]);
      } finally {
        setIsStreaming(false);
      }
    },
    [input, isStreaming, messages, qaData]
  );

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const canSend = input.trim().length > 0 && !isStreaming;

  return (
    <div
      className="abeer-root"
      dir="rtl"
      style={{
        height: "100%",
        width: "100%",
        background: "var(--bg)",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <style>{css}</style>

      <div
        style={{
          width: "100%",
          maxWidth: 480,
          height: "100%",
          background: "var(--white)",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 0 40px rgba(91,61,165,.08)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 16px 12px",
            borderBottom: "1px solid var(--border)",
            background: "var(--white)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 800,
                  color: "var(--text)",
                  letterSpacing: 0.5,
                }}
              >
                ABIR ELRIFAI
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                Abir Logic
              </div>
            </div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--purple)",
                background: "var(--purple-pale)",
                padding: "4px 10px",
                borderRadius: 999,
              }}
            >
              AI مساعدة
            </div>
          </div>

          <div
            style={{
              height: 1,
              background:
                "linear-gradient(90deg, transparent, var(--border), transparent)",
              marginBottom: 12,
            }}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar size={42} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                عبير الرفاعي
              </div>
              <div
                className="abeer-online"
                style={{ fontSize: 11, color: "var(--text-dim)" }}
              >
                متصلة الآن
              </div>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div
          className="abeer-scroll"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px",
            background: "var(--bg)",
          }}
        >
          {messages.length === 0 && <Welcome onAsk={(q) => sendMessage(q)} />}

          {messages.map((msg, i) => {
            const isUser = msg.role === "user";
            return (
              <div
                key={i}
                className="abeer-enter"
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 14,
                  flexDirection: isUser ? "row-reverse" : "row",
                  alignItems: "flex-end",
                }}
              >
                {isUser ? (
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      background: "var(--purple-mist)",
                      color: "var(--purple)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 700,
                      fontSize: 13,
                      flexShrink: 0,
                    }}
                  >
                    أ
                  </div>
                ) : (
                  <Avatar size={32} />
                )}

                <div style={{ display: "flex", flexDirection: "column", maxWidth: "78%", alignItems: isUser ? "flex-end" : "flex-start", gap: 6 }}>
                  <div
                    style={{
                      background: isUser
                        ? "linear-gradient(135deg, var(--purple), var(--purple-deep))"
                        : "var(--white)",
                      color: isUser ? "white" : "var(--text)",
                      border: isUser ? "none" : "1px solid var(--border)",
                      padding: "10px 13px",
                      borderRadius: 14,
                      borderBottomRightRadius: isUser ? 4 : 14,
                      borderBottomLeftRadius: isUser ? 14 : 4,
                      fontSize: 14,
                      lineHeight: 1.7,
                      whiteSpace: "pre-wrap",
                      boxShadow: isUser
                        ? "0 2px 12px rgba(91,61,165,.25)"
                        : "0 1px 4px rgba(91,61,165,.06)",
                    }}
                  >
                    {!isUser && (
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: "var(--purple)",
                          marginBottom: 4,
                        }}
                      >
                        عبير ✦
                      </div>
                    )}
                    {!isUser && msg.paid ? (
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                        <span style={{ color: "var(--gold)", fontSize: 16, lineHeight: 1.4 }}>🔒</span>
                        <span>
                          هذا السؤال يُكشف داخل جلسة الديكودنغ — احجزي مكانك واكتشفي الجواب الكامل.
                        </span>
                      </div>
                    ) : (
                      msg.content
                    )}
                  </div>

                  {!isUser && msg.paid && (
                    <a
                      href={COURSE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="abeer-cta"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        background: "linear-gradient(135deg, var(--purple), var(--purple-deep))",
                        color: "#fff",
                        textDecoration: "none",
                        padding: "10px 14px",
                        borderRadius: 12,
                        fontSize: 13,
                        fontWeight: 700,
                        fontFamily: "var(--font)",
                        boxShadow: "0 4px 14px rgba(91,61,165,.32)",
                        border: "1px solid rgba(232,184,75,.4)",
                      }}
                    >
                      <span style={{ color: "var(--gold)" }}>✦</span>
                      احجزي جلسة الديكودنغ
                      <span style={{ opacity: 0.8, fontSize: 12 }}>←</span>
                    </a>
                  )}
                </div>
              </div>
            );
          })}

          {isStreaming && (
            <div
              className="abeer-enter"
              style={{ display: "flex", gap: 8, alignItems: "flex-end" }}
            >
              <Avatar size={32} />
              <div
                style={{
                  background: "var(--white)",
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  borderBottomLeftRadius: 4,
                  padding: "12px 16px",
                }}
              >
                <span className="abeer-dot" />
                <span className="abeer-dot" />
                <span className="abeer-dot" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div
          style={{
            padding: "12px 14px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--white)",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 16,
              padding: "8px 12px",
            }}
          >
            <textarea
              ref={textareaRef}
              className="abeer-textarea"
              rows={1}
              placeholder="اكتبي سؤالك هنا..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
            />
            <button
              className="abeer-sendbtn"
              onClick={() => sendMessage()}
              disabled={!canSend}
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                flexShrink: 0,
                background: canSend
                  ? "linear-gradient(135deg, #5B3DA5, #3D2775)"
                  : "#DDD5F0",
                border: "none",
                cursor: canSend ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: canSend ? "white" : "#A896C8",
                boxShadow: canSend ? "0 2px 10px rgba(91,61,165,.3)" : "none",
              }}
            >
              <SendIcon />
            </button>
          </div>

          <div
            style={{
              textAlign: "center",
              marginTop: 8,
              fontSize: 10,
              color: "var(--text-muted)",
            }}
          >
            الإجابات مستندة لمنهج عبير الرفاعي · abirlogic.com
          </div>
        </div>
      </div>
    </div>
  );
}
