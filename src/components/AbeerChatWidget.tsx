import { useState, useEffect } from "react";
import AbeerChat from "./AbeerChat";
import abeerAvatar from "@/assets/abeer-avatar.jpg";

export default function AbeerChatWidget() {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);

  return (
    <>
      <style>{`
        @keyframes abeerWidgetIn {
          from { opacity: 0; transform: translateY(20px) scale(.96); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes abeerWidgetOut {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to   { opacity: 0; transform: translateY(20px) scale(.96); }
        }
        @keyframes abeerPulse {
          0%, 100% { box-shadow: 0 8px 24px rgba(91,61,165,.45), 0 0 0 0 rgba(91,61,165,.5); }
          50%      { box-shadow: 0 8px 24px rgba(91,61,165,.45), 0 0 0 14px rgba(91,61,165,0); }
        }
        .abeer-fab {
          position: fixed; bottom: 22px; right: 22px;
          width: 62px; height: 62px; border-radius: 50%;
          border: 3px solid #fff; cursor: pointer;
          background: linear-gradient(135deg, #5B3DA5, #3D2775);
          display: flex; align-items: center; justify-content: center;
          z-index: 9998; padding: 0; overflow: hidden;
          transition: transform .2s ease;
          animation: abeerPulse 2.4s ease-in-out infinite;
        }
        .abeer-fab:hover { transform: scale(1.06); }
        .abeer-fab img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
        .abeer-fab-badge {
          position: absolute; top: -2px; left: -2px;
          background: #E8B84B; color: #1C1130;
          font-family: 'Tajawal', sans-serif; font-weight: 800;
          font-size: 11px; min-width: 20px; height: 20px;
          border-radius: 50%; display: flex; align-items: center; justify-content: center;
          border: 2px solid #fff;
        }
        .abeer-widget-panel {
          position: fixed; bottom: 96px; right: 22px;
          width: min(400px, calc(100vw - 32px));
          height: min(640px, calc(100vh - 130px));
          border-radius: 18px; overflow: hidden; z-index: 9999;
          box-shadow: 0 18px 48px rgba(28,17,48,.28), 0 4px 14px rgba(28,17,48,.12);
          background: #fff;
          animation: abeerWidgetIn .22s ease forwards;
          display: flex; flex-direction: column;
        }
        .abeer-widget-close {
          position: absolute; top: 10px; left: 10px;
          width: 30px; height: 30px; border-radius: 50%;
          border: none; cursor: pointer;
          background: rgba(255,255,255,.92); color: #3D2775;
          display: flex; align-items: center; justify-content: center;
          font-size: 18px; font-weight: 700; line-height: 1;
          z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,.12);
          transition: transform .15s ease;
        }
        .abeer-widget-close:hover { transform: scale(1.1); }
        @media (max-width: 520px) {
          .abeer-widget-panel {
            bottom: 0; right: 0; left: 0;
            width: 100vw; height: 100vh; max-height: 100vh;
            border-radius: 0;
          }
          .abeer-fab { bottom: 18px; right: 18px; }
        }
      `}</style>

      {open && (
        <div className="abeer-widget-panel" role="dialog" aria-label="عبير الرفاعي - دردشة">
          <div style={{ flex: 1, minHeight: 0 }}>
            <AbeerChat />
          </div>
        </div>
      )}

      <button
        className="abeer-fab"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "إغلاق المحادثة" : "افتح المحادثة مع عبير"}
      >
        {open ? (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        ) : (
          <>
            <img src={abeerAvatar} alt="عبير" />
            {!hasOpened && <span className="abeer-fab-badge">1</span>}
          </>
        )}
      </button>
    </>
  );
}
