# Abeer Chat Widget — Integration Guide

This document tells an AI agent (or developer) exactly how to drop the **Abeer Al‑Rifai** Arabic chat widget into an existing website. The widget is a self‑contained floating bubble (bottom‑right) that opens an Arabic RTL chatbot powered by:

1. A local CSV knowledge base (free Q&A).
2. An NVIDIA‑hosted LLM (via a Supabase Edge Function) for free‑form Arabic answers.
3. A paid‑topic detector that, after a few messages, upsells to a course at `https://www.abirlogic.com/decoding`.

Everything works as‑is. Do not change behavior — just wire it into the host project.

---

## 1. Target stack

The widget is built for a project that already has:

- React 18 + TypeScript + Vite
- Tailwind CSS v3
- `@supabase/supabase-js` v2 client
- Lovable Cloud / Supabase backend (for the edge function)

If the host project is plain HTML or another framework, mount it as a small React island.

---

## 2. Files to copy

Copy these files into the host project, preserving paths:

| Source                                            | Destination (in host project)                     |
|---------------------------------------------------|---------------------------------------------------|
| `src/components/AbeerChat.tsx`                    | `src/components/AbeerChat.tsx`                    |
| `src/components/AbeerChatWidget.tsx`              | `src/components/AbeerChatWidget.tsx`              |
| `src/assets/abeer-avatar.jpg`                     | `src/assets/abeer-avatar.jpg`                     |
| `src/assets/abeer-qa.csv`                         | `src/assets/abeer-qa.csv`                         |
| `supabase/functions/abeer-chat/index.ts`          | `supabase/functions/abeer-chat/index.ts`          |

`AbeerChat.tsx` uses these imports — keep them resolvable:

```ts
import Papa from "papaparse";
import bundledCsv from "@/assets/abeer-qa.csv?raw";
import abeerAvatar from "@/assets/abeer-avatar.jpg";
import { supabase } from "@/integrations/supabase/client";
```

The `@/` alias must resolve to `src/` (already standard in Lovable / Vite projects).

---

## 3. Dependencies

Install in the host project:

```bash
bun add papaparse @supabase/supabase-js
bun add -d @types/papaparse
```

Vite must allow importing `?raw` (default behavior — no config change needed).

The Google font `Tajawal` is loaded via CSS inside the component; no extra setup needed, but for best results add to `index.html` `<head>`:

```html
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet" />
```

---

## 4. Backend: Supabase Edge Function

The widget calls `supabase.functions.invoke("abeer-chat", { body: { messages, system } })`.

### 4.1 Deploy

The function file is `supabase/functions/abeer-chat/index.ts`. On Lovable Cloud it auto‑deploys. On a self‑managed Supabase project:

```bash
supabase functions deploy abeer-chat --no-verify-jwt
```

It is safe to run with `verify_jwt = false` — the widget is public on the website.

### 4.2 Required secret

Add an NVIDIA Build API key as a runtime secret named **`NVIDIA_API_KEY`**:

- Lovable Cloud: use the secrets tool / Cloud → Secrets.
- Supabase CLI: `supabase secrets set NVIDIA_API_KEY=nvapi-...`

Get the key from https://build.nvidia.com/. The function calls `https://integrate.api.nvidia.com/v1/chat/completions` with the `openai/gpt-oss-20b` model by default.

### 4.3 What the function does

- Forwards `messages` + optional `system` to NVIDIA.
- Strips reasoning / thinking blocks and prompt‑echo lines.
- Keeps only Arabic‑bearing lines.
- Retries once with a strict Arabic‑only nudge if the first pass is unusable.
- Falls back to "هالسؤال مو من اختصاصي…" if no clean Arabic reply can be extracted.
- Returns `{ reply, raw }`.

You do not need to modify it.

---

## 5. Mounting the widget

Render `<AbeerChatWidget />` once, near the root of the app (e.g. in `App.tsx` or a layout component). It is `position: fixed`, so placement in the tree does not matter.

```tsx
import AbeerChatWidget from "@/components/AbeerChatWidget";

export default function App() {
  return (
    <>
      {/* ...existing site... */}
      <AbeerChatWidget />
    </>
  );
}
```

For non‑React hosts, mount a tiny React root:

```tsx
import { createRoot } from "react-dom/client";
import AbeerChatWidget from "@/components/AbeerChatWidget";

const el = document.createElement("div");
document.body.appendChild(el);
createRoot(el).render(<AbeerChatWidget />);
```

---

## 6. Configuration knobs

All inside `src/components/AbeerChat.tsx`, top of file:

| Constant         | Purpose                                                                 |
|------------------|-------------------------------------------------------------------------|
| `SHEET_CSV_URL`  | Optional published Google Sheet CSV URL. If set, overrides bundled CSV and refreshes every `REFRESH_MS`. |
| `REFRESH_MS`     | Refetch interval for the sheet (default 1 hour).                        |
| `COURSE_URL`     | CTA destination. Default: `https://www.abirlogic.com/decoding`.         |
| `AVATAR_URL`     | Bot avatar image.                                                       |

The upsell CTA fires from the **8th** user message onward whenever a paid topic is detected. To change, search for `userMsgCount >= 8` in `AbeerChat.tsx`.

---

## 7. Knowledge base (CSV)

`src/assets/abeer-qa.csv` is a 3‑column file: `q,a,t` where `t` is the topic tag. Free topics are answered from the CSV (fuzzy Arabic match). Paid topics trigger a teaser + CTA to `COURSE_URL` instead of a full answer.

To update content, either edit the CSV in the repo or publish a Google Sheet and set `SHEET_CSV_URL`.

---

## 8. Styling / RTL

The component injects its own scoped CSS (Tajawal font, RTL layout, purple gradient theme `#5B3DA5 → #3D2775`, gold accent `#E8B84B`). It does not depend on the host's Tailwind tokens and will not collide with the host design system.

The floating bubble is `z-index: 9998` and the panel is `9999`. Make sure the host has nothing above `9999` that would cover it.

---

## 9. Smoke test

After integration:

1. Load the site → a pulsing purple avatar appears bottom‑right with a `1` badge.
2. Click it → RTL chat panel opens with Abeer's intro message.
3. Send an Arabic question matching a row in the CSV → instant answer.
4. Send an off‑topic Arabic question → NVIDIA‑backed reply.
5. Send 8+ messages including a paid‑topic keyword → CTA button linking to `https://www.abirlogic.com/decoding` appears.
6. Send English / nonsense → fallback "هالسؤال مو من اختصاصي…".

If step 4 fails with a 500, the `NVIDIA_API_KEY` secret is missing or invalid.

---

## 10. Do NOT change

- `src/integrations/supabase/client.ts` — auto‑generated.
- `src/integrations/supabase/types.ts` — auto‑generated.
- The extraction / fallback logic in `supabase/functions/abeer-chat/index.ts` — it intentionally hides model reasoning and prompt echoes from end users.
