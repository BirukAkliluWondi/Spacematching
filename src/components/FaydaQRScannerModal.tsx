'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldCheck, QrCode, AlertCircle, CheckCircle, X, Loader2, Camera, ShieldAlert, Sparkles } from 'lucide-react';

interface FaydaQRScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  telegramId: number;
  faydaStatus: string;
  onVerificationSuccess: (data: { faydaNumber?: string; fullName?: string }) => void;
}

export function FaydaQRScannerModal({
  isOpen,
  onClose,
  telegramId,
  faydaStatus,
  onVerificationSuccess,
}: FaydaQRScannerModalProps) {
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [verifiedData, setVerifiedData] = useState<{ faydaNumber?: string; fullName?: string } | null>(null);
  const [manualCodeInput, setManualCodeInput] = useState('');
  const [showManualFallback, setShowManualFallback] = useState(false);

  if (!isOpen) return null;

  const handleStartScan = () => {
    setErrorMsg(null);
    const tg = typeof window !== 'undefined' ? (window as any).Telegram?.WebApp : undefined;

    if (tg && typeof tg.showScanQrPopup === 'function') {
      try {
        tg.showScanQrPopup(
          { text: 'Point your camera at the QR code on your Fayda card or e-Fayda slip' },
          async (qrText: string) => {
            if (tg.closeScanQrPopup) {
              tg.closeScanQrPopup();
            }
            if (qrText) {
              await processQrData(qrText);
            }
            return true;
          }
        );
        return;
      } catch (err) {
        console.warn('Native Telegram QR popup failed, falling back:', err);
      }
    }

    // Fallback if not inside Telegram mobile client (e.g. desktop browser test)
    setShowManualFallback(true);
  };

  const processQrData = async (rawQr: string) => {
    setIsVerifying(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/user/verify-fayda-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          qr_data: rawQr,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to verify Fayda QR code.');
      }

      setVerifiedData({
        faydaNumber: data.fayda_number,
        fullName: data.full_name,
      });

      onVerificationSuccess({
        faydaNumber: data.fayda_number,
        fullName: data.full_name,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid QR code. Please try again.';
      setErrorMsg(msg);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualCodeInput.trim()) {
      processQrData(manualCodeInput.trim());
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          className="relative w-full max-w-sm rounded-3xl luxury-card bg-gradient-to-b from-[#111A2E] via-[#0D1527] to-[#080D1A] border border-[#0088CC]/30 p-6 shadow-2xl overflow-hidden"
        >
          {/* Background Ambient Glow */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-44 h-44 bg-[#0088CC]/15 rounded-full blur-3xl pointer-events-none" />

          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Modal Content */}
          <div className="text-center space-y-4">
            {verifiedData ? (
              /* Verified Success State */
              <div className="py-4 space-y-4">
                <div className="w-16 h-16 mx-auto rounded-3xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                  <ShieldCheck className="w-9 h-9 text-emerald-400" />
                </div>

                <div className="space-y-1">
                  <h3 className="text-lg font-black text-white flex items-center justify-center gap-1.5">
                    Fayda Verified! <Sparkles className="w-4 h-4 text-emerald-400 animate-pulse" />
                  </h3>
                  <p className="text-xs text-slate-300">
                    Your Ethiopian Fayda National ID has been verified successfully.
                  </p>
                </div>

                <div className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/10 text-left space-y-1.5 text-xs">
                  <div className="flex justify-between items-center text-slate-400">
                    <span>Fayda Number:</span>
                    <span className="font-mono text-emerald-400 font-bold">
                      •••• •••• {verifiedData.faydaNumber ? verifiedData.faydaNumber.slice(-4) : '****'}
                    </span>
                  </div>
                  {verifiedData.fullName && (
                    <div className="flex justify-between items-center text-slate-400">
                      <span>Verified Name:</span>
                      <span className="text-white font-semibold">{verifiedData.fullName}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center text-slate-400">
                    <span>Community Status:</span>
                    <span className="px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-400 text-[10px] font-black border border-emerald-500/40">
                      🛡️ VERIFIED
                    </span>
                  </div>
                </div>

                <button
                  onClick={onClose}
                  className="w-full py-3 rounded-2xl bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-black text-xs shadow-lg shadow-emerald-500/30 transition-all active:scale-95"
                >
                  Continue to SpaceMatch 🚀
                </button>
              </div>
            ) : (
              /* Scanning & Prompt State */
              <>
                <div className="w-16 h-16 mx-auto rounded-3xl bg-gradient-to-tr from-[#0088CC]/20 via-[#00A3FF]/20 to-transparent border border-[#0088CC]/40 flex items-center justify-center shadow-lg shadow-[#0088CC]/20">
                  <QrCode className="w-8 h-8 text-[#00A3FF]" />
                </div>

                <div className="space-y-1">
                  <h3 className="text-lg font-black text-white">
                    Fayda National ID Scan
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    SpaceMatch Addis requires Fayda ID verification to protect our community. Scan the QR code on your Fayda card or e-Fayda slip.
                  </p>
                </div>

                {/* Privacy Guarantee Box */}
                <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/10 text-left flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-[#0088CC] mt-0.5 shrink-0" />
                  <p className="text-[11px] text-slate-300 leading-snug">
                    <strong className="text-white">100% Offline &amp; Private:</strong> Scanned directly from your card without contacting government servers.
                  </p>
                </div>

                {/* Error Banner */}
                {errorMsg && (
                  <div className="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-start gap-2 text-left">
                    <AlertCircle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-rose-300 leading-tight">{errorMsg}</p>
                  </div>
                )}

                {/* Primary Scan Button */}
                <button
                  onClick={handleStartScan}
                  disabled={isVerifying}
                  className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-[#0088CC] via-[#0099e6] to-[#00b4d8] hover:opacity-95 text-white font-black text-xs shadow-xl shadow-[#0088CC]/35 flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                >
                  {isVerifying ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Verifying QR Data...</span>
                    </>
                  ) : (
                    <>
                      <Camera className="w-4 h-4 animate-icon-shake" />
                      <span>Open Camera &amp; Scan QR Code</span>
                    </>
                  )}
                </button>

                {/* Manual Fallback for Desktop/Browser testing */}
                {showManualFallback && (
                  <form onSubmit={handleManualSubmit} className="pt-2 border-t border-white/10 space-y-2">
                    <p className="text-[10px] text-slate-400">
                      Camera not supported in browser? Paste QR data or 12-digit FIN:
                    </p>
                    <input
                      type="text"
                      value={manualCodeInput}
                      onChange={(e) => setManualCodeInput(e.target.value)}
                      placeholder="e.g. 1234 5678 9012 or QR text"
                      className="w-full px-3 py-2 text-xs rounded-xl bg-slate-900 border border-white/15 text-white placeholder:text-slate-500 focus:outline-none focus:border-[#0088CC]"
                    />
                    <button
                      type="submit"
                      disabled={isVerifying || !manualCodeInput.trim()}
                      className="w-full py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs text-white font-bold disabled:opacity-40"
                    >
                      Verify Input
                    </button>
                  </form>
                )}
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
