'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  MapPin,
  Lock,
  Unlock,
  Copy,
  Check,
  Phone,
  MessageCircle,
  ExternalLink,
  Loader2,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  Send,
  Building,
  CreditCard,
  Upload,
  Sparkles,
} from 'lucide-react';
import { SpaceSummary } from './FeedView';

interface SpaceDetailSheetProps {
  space: SpaceSummary | null;
  onClose: () => void;
  telegramId: number;
}

export interface ConnectReadyDetails {
  bot_connect_url: string;
  days_remaining?: number;
}

export function SpaceDetailSheet({ space, onClose, telegramId }: SpaceDetailSheetProps) {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [step, setStep] = useState<'details' | 'payment' | 'unlocked'>('details');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [receiverPhone, setReceiverPhone] = useState<string>('0987310978');
  const [abyssiniaAccount, setAbyssiniaAccount] = useState<string>('256861771');
  const [dashenAccount, setDashenAccount] = useState<string>('2922175078411');
  const [txRefInput, setTxRefInput] = useState<string>('');
  const [receiptBase64, setReceiptBase64] = useState<string | null>(null);
  const [receiptFileName, setReceiptFileName] = useState<string | null>(null);
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedAbyssinia, setCopiedAbyssinia] = useState(false);
  const [copiedDashen, setCopiedDashen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [connectDetails, setConnectDetails] = useState<ConnectReadyDetails | null>(null);
  const [botPayUrl, setBotPayUrl] = useState<string | null>(null);

  useEffect(() => {
    if (space) {
      setStep('details');
      setOrderId(null);
      setTxRefInput('');
      setReceiptBase64(null);
      setReceiptFileName(null);
      setErrorMsg(null);
      setConnectDetails(null);
      setBotPayUrl(null);
      setCurrentImageIndex(0);
    }
  }, [space]);

  useEffect(() => {
    if (!space) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [space, onClose]);

  if (!space) return null;

  const images =
    space.space_images && space.space_images.length > 0
      ? space.space_images.map((img) => img.image_path)
      : ['https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=800&q=80'];

  const rawBotUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot';
  const cleanBotUsername = rawBotUsername.replace('@', '');

  const handleStartUnlock = async () => {
    setIsCreatingOrder(true);
    setErrorMsg(null);

    try {
      const tg = (window as any).Telegram?.WebApp;
      const initData: string = tg?.initData || '';
      const res = await fetch('/api/orders/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(initData ? { 'x-telegram-init-data': initData } : {}),
        },
        body: JSON.stringify({
          space_id: space.id,
          telegram_id: telegramId,
          initData,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to initialize unlock order.');
      }

      if (data.already_unlocked || data.double_blind_ready) {
        setConnectDetails({
          bot_connect_url: data.bot_connect_url || `https://t.me/${cleanBotUsername}?start=order_${space.id}`,
          days_remaining: data.days_remaining,
        });
        setStep('unlocked');
        return;
      }

      setOrderId(data.order_id);
      if (data.telebirr_receiver_phone) {
        setReceiverPhone(data.telebirr_receiver_phone);
      }
      if (data.abyssinia_account) {
        setAbyssiniaAccount(data.abyssinia_account);
      }
      if (data.dashen_account) {
        setDashenAccount(data.dashen_account);
      }

      setBotPayUrl(`https://t.me/${cleanBotUsername}?start=order_${space.id}`);
      setStep('payment');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    } finally {
      setIsCreatingOrder(false);
    }
  };

  const handleReceiptFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setErrorMsg('Receipt screenshot must be smaller than 8 MB.');
      return;
    }
    setReceiptFileName(file.name);
    setErrorMsg(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setReceiptBase64(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleVerifyReceipt = async () => {
    if (!orderId || (!txRefInput.trim() && !receiptBase64)) {
      setErrorMsg('Please upload your payment receipt screenshot or enter your transaction reference code.');
      return;
    }

    setIsVerifying(true);
    setErrorMsg(null);

    try {
      const tg = (window as any).Telegram?.WebApp;
      const initData: string = tg?.initData || '';
      const res = await fetch('/api/orders/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(initData ? { 'x-telegram-init-data': initData } : {}),
        },
        body: JSON.stringify({
          order_id: orderId,
          telegram_id: telegramId,
          ...(txRefInput.trim() ? { transaction_reference: txRefInput.trim() } : {}),
          ...(receiptBase64 ? { receipt_image: receiptBase64 } : {}),
          initData,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Transaction verification failed.');
      }

      setConnectDetails({
        bot_connect_url: data.bot_connect_url || `https://t.me/${cleanBotUsername}?start=order_${space.id}`,
      });
      setStep('unlocked');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    } finally {
      setIsVerifying(false);
    }
  };

  const copyPhone = () => {
    navigator.clipboard.writeText(receiverPhone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  };

  const copyAbyssinia = () => {
    navigator.clipboard.writeText(abyssiniaAccount);
    setCopiedAbyssinia(true);
    setTimeout(() => setCopiedAbyssinia(false), 2000);
  };

  const copyDashen = () => {
    navigator.clipboard.writeText(dashenAccount);
    setCopiedDashen(true);
    setTimeout(() => setCopiedDashen(false), 2000);
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        {/* Dark Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-slate-950/80 backdrop-blur-md"
        />

        {/* Modal Sheet Wrapper */}
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="relative w-full max-w-md sm:max-w-lg max-h-[90vh] rounded-t-3xl sm:rounded-3xl bg-[#0D1424] border-t sm:border border-white/10 text-white overflow-y-auto no-scrollbar shadow-2xl z-10"
        >
          {/* Top Bar Header */}
          <div className="sticky top-0 z-20 bg-[#0D1424]/95 backdrop-blur-md py-3 px-4 flex items-center justify-between border-b border-white/10">
            <div className="w-12 h-1.5 rounded-full bg-slate-700 mx-auto" />
            <button
              onClick={onClose}
              className="absolute right-4 top-2.5 p-2 rounded-full bg-white/[0.06] hover:bg-white/10 text-slate-300 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-4">
            {/* Image Gallery Slider */}
            <div className="relative w-full h-56 rounded-3xl bg-slate-900 overflow-hidden border border-white/10 shadow-inner">
              <img
                src={images[currentImageIndex]}
                alt={space.title}
                className="w-full h-full object-cover transition-all duration-300"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent" />

              {/* Navigation Arrows */}
              {images.length > 1 && (
                <>
                  <button
                    onClick={() => setCurrentImageIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1))}
                    className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-950/60 backdrop-blur-md text-white border border-white/10 hover:bg-slate-950/80"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setCurrentImageIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1))}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-950/60 backdrop-blur-md text-white border border-white/10 hover:bg-slate-950/80"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </>
              )}

              {/* Image Counter Indicator */}
              <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded-full bg-slate-950/80 backdrop-blur-md border border-white/10 text-[10px] font-bold text-slate-200">
                {currentImageIndex + 1} / {images.length}
              </div>
            </div>

            {/* Error Message Alert */}
            {errorMsg && (
              <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* STEP 1: SPACE DETAILS */}
            {step === 'details' && (
              <div className="space-y-4">
                {/* Title & Price Row */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xl font-black text-emerald-400">
                      ETB {Number(space.price_per_month).toLocaleString()}
                      <span className="text-xs font-normal text-slate-400">/mo</span>
                    </span>
                    <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold">
                      3-Month Pass: {space.unlock_fee || 100} ETB
                    </span>
                  </div>
                  <h2 className="text-lg font-black text-white leading-snug">{space.title}</h2>
                  <p className="text-xs text-slate-400 flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                    <span>{space.neighborhood}, Addis Ababa</span>
                  </p>
                </div>

                {/* Description */}
                <div className="p-4 rounded-2xl bg-white/[0.04] border border-white/10 space-y-1">
                  <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">About This Space</h4>
                  <p className="text-xs text-slate-300 leading-relaxed">{space.description}</p>
                </div>

                {/* Connect Call to Action */}
                <button
                  onClick={handleStartUnlock}
                  disabled={isCreatingOrder}
                  className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-sm shadow-xl shadow-emerald-500/25 flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                >
                  {isCreatingOrder ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                      <span>Initializing...</span>
                    </>
                  ) : (
                    <>
                      <Unlock className="w-4 h-4 stroke-[3]" />
                      <span>Connect with Host ({space.unlock_fee || 100} ETB Pass)</span>
                    </>
                  )}
                </button>
              </div>
            )}

            {/* STEP 2: PAYMENT RECEIPT INSTRUCTIONS & VERIFICATION */}
            {step === 'payment' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 space-y-1">
                  <h3 className="font-extrabold text-sm text-emerald-300">Payment Verification Required / ክፍያ ያረጋግጡ</h3>
                  <p className="text-xs text-slate-300">
                    Transfer <strong>{space.unlock_fee || 100} ETB</strong> via Telebirr, Abyssinia, or Dashen to activate your 3-Month All-Access Pass, then upload your receipt screenshot or enter your transaction code.
                  </p>
                </div>

                {/* Telebirr Account Box */}
                <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-1.5">
                  <span className="text-[11px] text-slate-400 font-bold uppercase">Telebirr</span>
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-1.5 font-mono text-base font-black text-emerald-400">
                      <span>{receiverPhone}</span>
                      <span className="text-xs text-emerald-300 font-sans font-medium">(Wahid)</span>
                    </div>
                    <button
                      onClick={copyPhone}
                      className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold text-white flex items-center gap-1 transition-colors"
                    >
                      {copiedPhone ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedPhone ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                {/* Bank of Abyssinia Box */}
                <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-1.5">
                  <span className="text-[11px] text-slate-400 font-bold uppercase">Bank of Abyssinia</span>
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-1.5 font-mono text-base font-black text-amber-400">
                      <span>{abyssiniaAccount}</span>
                      <span className="text-xs text-amber-300 font-sans font-medium">(Wahid)</span>
                    </div>
                    <button
                      onClick={copyAbyssinia}
                      className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold text-white flex items-center gap-1 transition-colors"
                    >
                      {copiedAbyssinia ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedAbyssinia ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                {/* Dashen Bank Box */}
                <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-1.5">
                  <span className="text-[11px] text-slate-400 font-bold uppercase">Dashen Bank</span>
                  <div className="flex items-center justify-between">
                    <div className="flex items-baseline gap-1.5 font-mono text-base font-black text-cyan-400">
                      <span>{dashenAccount}</span>
                      <span className="text-xs text-cyan-300 font-sans font-medium">(Wahid)</span>
                    </div>
                    <button
                      onClick={copyDashen}
                      className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold text-white flex items-center gap-1 transition-colors"
                    >
                      {copiedDashen ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedDashen ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                {/* Upload Receipt Screenshot (In-Memory OCR) */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-300">
                    Upload Payment Receipt Screenshot / የክፍያ ደረሰኝ ፎቶ ይላኩ:
                  </label>
                  <label className="flex items-center justify-between gap-2 p-3.5 rounded-2xl bg-emerald-500/10 border border-dashed border-emerald-500/40 cursor-pointer hover:bg-emerald-500/15 transition-colors">
                    <span className="text-xs text-emerald-200 font-semibold truncate">
                      {receiptFileName || 'Tap to upload Telebirr / CBE / BoA / Dashen screenshot'}
                    </span>
                    <Upload className="w-4 h-4 text-emerald-400 shrink-0" />
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleReceiptFileChange}
                      className="hidden"
                    />
                  </label>
                </div>

                {/* Receipt Ref Input */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-300">
                    Or Enter Transaction Reference / የግብይት ቁጥር (Txn Ref / FT...):
                  </label>
                  <input
                    type="text"
                    value={txRefInput}
                    onChange={(e) => setTxRefInput(e.target.value)}
                    placeholder="e.g. DKM7J1EXAP or FT26092..."
                    className="w-full p-3.5 rounded-2xl bg-white/[0.06] border border-white/15 text-xs text-white placeholder-slate-500 font-mono font-bold focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  />
                </div>

                <button
                  onClick={handleVerifyReceipt}
                  disabled={isVerifying}
                  className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-sm shadow-xl shadow-emerald-500/25 flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                >
                  {isVerifying ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                      <span>Verifying Receipt...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4 stroke-[3]" />
                      <span>Verify Receipt & Activate Pass</span>
                    </>
                  )}
                </button>
                {botPayUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      const tg = (window as any).Telegram?.WebApp;
                      if (tg?.openTelegramLink) tg.openTelegramLink(botPayUrl);
                      else window.open(botPayUrl, '_blank');
                    }}
                    className="w-full py-2.5 px-4 rounded-2xl bg-white/[0.06] hover:bg-white/10 text-xs font-bold text-slate-200 border border-white/10 flex items-center justify-center gap-2"
                  >
                    <Send className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Or verify via @{cleanBotUsername}</span>
                  </button>
                )}
              </div>
            )}

            {/* STEP 3: DOUBLE-BLIND CONSENT READY VIEW (ZERO UNCONSENTED PII) */}
            {step === 'unlocked' && connectDetails && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 text-center space-y-1.5">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
                  <h3 className="font-black text-base text-white">3-Month Pass Active / አባልነትዎ ነቅቷል!</h3>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    SpaceMatch uses Double-Blind Mutual Consent to protect host privacy. Send your connection request in the bot — direct contact info is shared automatically once the host accepts.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const tg = (window as any).Telegram?.WebApp;
                    if (tg?.openTelegramLink) tg.openTelegramLink(connectDetails.bot_connect_url);
                    else window.open(connectDetails.bot_connect_url, '_blank');
                  }}
                  className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-sm shadow-xl shadow-emerald-500/25 flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                  <MessageCircle className="w-4 h-4 stroke-[2.5]" />
                  <span>Send Connection Request in Bot / ጥያቄ ላክ</span>
                </button>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
