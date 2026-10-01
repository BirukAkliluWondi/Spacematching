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
  Sparkles,
} from 'lucide-react';
import { SpaceSummary } from './FeedView';

interface SpaceDetailSheetProps {
  space: SpaceSummary | null;
  onClose: () => void;
  telegramId: number;
}

export interface UnlockedDetails {
  exact_address: string;
  latitude: number;
  longitude: number;
  contact_name: string;
  contact_phone: string;
  contact_telegram?: string;
  google_maps_url?: string;
}

export function SpaceDetailSheet({ space, onClose, telegramId }: SpaceDetailSheetProps) {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [step, setStep] = useState<'details' | 'payment' | 'unlocked'>('details');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [receiverPhone, setReceiverPhone] = useState<string>('0987310978');
  const [cbeAccount, setCbeAccount] = useState<string>('1000054066094');
  const [txRefInput, setTxRefInput] = useState<string>('');
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedCbe, setCopiedCbe] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [unlockedData, setUnlockedData] = useState<UnlockedDetails | null>(null);
  const [botPayUrl, setBotPayUrl] = useState<string | null>(null);

  useEffect(() => {
    if (space) {
      setStep('details');
      setOrderId(null);
      setTxRefInput('');
      setErrorMsg(null);
      setUnlockedData(null);
      setBotPayUrl(null);
      setCurrentImageIndex(0);
    }
  }, [space]);

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
      const res = await fetch('/api/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          space_id: space.id,
          telegram_id: telegramId,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to initialize unlock order.');
      }

      if (data.already_unlocked && data.unlocked_details) {
        setUnlockedData(data.unlocked_details);
        setStep('unlocked');
        return;
      }

      setOrderId(data.order_id);
      if (data.telebirr_receiver_phone) {
        setReceiverPhone(data.telebirr_receiver_phone);
      }

      const payUrl = `https://t.me/${cleanBotUsername}?start=pay_${data.order_id}`;
      setBotPayUrl(payUrl);

      const tg = (window as any).Telegram?.WebApp;
      if (tg && typeof tg.openTelegramLink === 'function') {
        try {
          tg.openTelegramLink(payUrl);
        } catch (e) {
          console.error('Error in tg.openTelegramLink:', e);
        }
      }

      setStep('payment');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
    } finally {
      setIsCreatingOrder(false);
    }
  };

  const handleVerifyReceipt = async () => {
    if (!orderId || !txRefInput.trim()) {
      setErrorMsg('Please enter your Telebirr or CBE transaction reference number.');
      return;
    }

    setIsVerifying(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/orders/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: orderId,
          telegram_id: telegramId,
          transaction_reference: txRefInput.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Transaction verification failed.');
      }

      setUnlockedData(data.unlocked_details);
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

  const copyCbe = () => {
    navigator.clipboard.writeText(cbeAccount);
    setCopiedCbe(true);
    setTimeout(() => setCopiedCbe(false), 2000);
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-end justify-center">
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
          className="relative w-full max-w-md sm:max-w-lg max-h-[90vh] rounded-t-3xl bg-[#0D1424] border-t border-white/10 text-white overflow-y-auto no-scrollbar shadow-2xl z-10"
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
                      Unlock Fee: {space.unlock_fee || 50} ETB
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

                {/* Unlock Contact Call to Action */}
                <button
                  onClick={handleStartUnlock}
                  disabled={isCreatingOrder}
                  className="w-full py-3.5 px-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-sm shadow-xl shadow-emerald-500/25 flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                >
                  {isCreatingOrder ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                      <span>Initializing Order...</span>
                    </>
                  ) : (
                    <>
                      <Unlock className="w-4 h-4 stroke-[3]" />
                      <span>Unlock Contact Information ({space.unlock_fee || 50} ETB)</span>
                    </>
                  )}
                </button>
              </div>
            )}

            {/* STEP 2: PAYMENT RECEIPT INSTRUCTIONS & VERIFICATION */}
            {step === 'payment' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 space-y-1">
                  <h3 className="font-extrabold text-sm text-emerald-300">Payment Verification Required</h3>
                  <p className="text-xs text-slate-300">
                    Transfer <strong>{space.unlock_fee || 50} ETB</strong> via Telebirr or CBE to unlock homeowner details instantly.
                  </p>
                </div>

                {/* Telebirr Account Box */}
                <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-1.5">
                  <span className="text-[11px] text-slate-400 font-bold uppercase">📱 Telebirr Merchant Phone</span>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-base font-black text-emerald-400">{receiverPhone}</span>
                    <button
                      onClick={copyPhone}
                      className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold text-white flex items-center gap-1 transition-colors"
                    >
                      {copiedPhone ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedPhone ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                {/* CBE Account Box */}
                <div className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-1.5">
                  <span className="text-[11px] text-slate-400 font-bold uppercase">🏦 Commercial Bank of Ethiopia (CBE)</span>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-base font-black text-amber-400">{cbeAccount}</span>
                    <button
                      onClick={copyCbe}
                      className="px-3 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-xs font-bold text-white flex items-center gap-1 transition-colors"
                    >
                      {copiedCbe ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedCbe ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                {/* Receipt Ref Input */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-300">Enter Transaction Reference (Txn Ref / FT...):</label>
                  <input
                    type="text"
                    value={txRefInput}
                    onChange={(e) => setTxRefInput(e.target.value)}
                    placeholder="e.g. 9AC4827X19 or FT24..."
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
                      <span>Verifying Receipt with verify.et...</span>
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4 stroke-[3]" />
                      <span>Submit & Verify Receipt</span>
                    </>
                  )}
                </button>
              </div>
            )}

            {/* STEP 3: UNLOCKED DETAILS VIEW */}
            {step === 'unlocked' && unlockedData && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 text-center space-y-1">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
                  <h3 className="font-black text-base text-white">Contact Details Unlocked!</h3>
                  <p className="text-xs text-slate-300">You can now contact the homeowner directly.</p>
                </div>

                <div className="p-4 rounded-2xl bg-white/[0.04] border border-white/10 space-y-3">
                  <div>
                    <span className="text-[10px] text-slate-400 font-bold uppercase">Homeowner Name</span>
                    <p className="text-sm font-bold text-white">{unlockedData.contact_name}</p>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-400 font-bold uppercase">Phone Number</span>
                    <p className="text-sm font-mono font-bold text-emerald-400">{unlockedData.contact_phone}</p>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-400 font-bold uppercase">Exact Address</span>
                    <p className="text-xs text-slate-300">{unlockedData.exact_address}</p>
                  </div>
                </div>

                {/* Direct Action Buttons */}
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <a
                    href={`tel:${unlockedData.contact_phone}`}
                    className="py-3 px-4 rounded-2xl bg-emerald-500 text-slate-950 font-black text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20"
                  >
                    <Phone className="w-4 h-4" />
                    <span>Call Homeowner</span>
                  </a>

                  {unlockedData.google_maps_url && (
                    <a
                      href={unlockedData.google_maps_url}
                      target="_blank"
                      rel="noreferrer"
                      className="py-3 px-4 rounded-2xl bg-white/10 hover:bg-white/20 text-white font-bold text-xs flex items-center justify-center gap-2 border border-white/10"
                    >
                      <MapPin className="w-4 h-4 text-emerald-400" />
                      <span>Google Maps</span>
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
