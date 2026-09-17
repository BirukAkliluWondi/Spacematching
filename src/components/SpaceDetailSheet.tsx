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
  const [txRefInput, setTxRefInput] = useState<string>('');
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [copied, setCopied] = useState(false);
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

      // Attempt Telegram Mini App WebApp redirect if running inside Telegram
      const tg = (window as any).Telegram?.WebApp;
      if (tg && typeof tg.openTelegramLink === 'function') {
        try {
          tg.openTelegramLink(payUrl);
        } catch (e) {
          console.error('Error in tg.openTelegramLink:', e);
        }
      }

      // Transition to payment step in-app
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
      setErrorMsg('Please enter your Telebirr transaction reference number.');
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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
          className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
        />

        {/* Crisp Light Modal Sheet Wrapper */}
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="relative w-full max-w-md sm:max-w-lg max-h-[90vh] rounded-t-3xl bg-white overflow-y-auto no-scrollbar shadow-2xl border-t border-slate-200 text-slate-900 z-10"
        >
          {/* Sticky Header Drag Handle */}
          <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-md py-3 px-4 flex items-center justify-between border-b border-slate-200/80">
            <div className="w-12 h-1.5 rounded-full bg-slate-300 mx-auto" />
            <button
              onClick={onClose}
              className="absolute right-4 top-2.5 p-1.5 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Photo Carousel Container */}
          <div className="relative w-full h-64 bg-slate-100">
            <img
              src={images[currentImageIndex]}
              alt={space.title}
              className="w-full h-full object-cover transition-all duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-900/60 via-transparent to-transparent" />

            {/* Carousel Controls */}
            {images.length > 1 && (
              <>
                <button
                  onClick={() => setCurrentImageIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1))}
                  className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-900/50 backdrop-blur-md text-white hover:bg-slate-900/80 transition-all"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setCurrentImageIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-900/50 backdrop-blur-md text-white hover:bg-slate-900/80 transition-all"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <div className="absolute bottom-3 right-4 px-2 py-0.5 rounded-md bg-slate-900/70 text-[10px] text-white font-mono">
                  {currentImageIndex + 1} / {images.length}
                </div>
              </>
            )}

            {/* Price Tag Badge */}
            <div className="absolute bottom-3 left-4 px-3 py-1.5 rounded-xl bg-slate-900/90 backdrop-blur-md text-white font-extrabold text-sm shadow-lg border border-slate-700/60">
              ETB {Number(space.price_per_month).toLocaleString()} <span className="text-xs font-normal text-slate-300">/ month</span>
            </div>
          </div>

          {/* Sheet Body Content */}
          <div className="p-5 space-y-5">
            {/* Title & Neighborhood */}
            <div>
              <div className="flex items-center gap-1.5 text-xs text-rose-600 font-bold mb-1">
                <MapPin className="w-3.5 h-3.5" />
                <span>{space.neighborhood}, Addis Ababa</span>
              </div>
              <h2 className="text-xl font-extrabold text-slate-900 leading-snug">{space.title}</h2>
            </div>

            {/* Privacy Locked Notice */}
            {step !== 'unlocked' && (
              <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-3 shadow-sm">
                <Lock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <strong className="block font-bold text-amber-950">Zero-Trust Contact Protection</strong>
                  Exact address, homeowner phone number, and Telegram handle remain locked until payment confirmation.
                </div>
              </div>
            )}

            {/* Description */}
            <div className="space-y-1">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Property Details</h4>
              <p className="text-xs text-slate-700 leading-relaxed font-normal">{space.description}</p>
            </div>

            {/* Amenities List */}
            {space.amenities && space.amenities.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Amenities</h4>
                <div className="flex flex-wrap gap-2">
                  {space.amenities.map((item, idx) => (
                    <span
                      key={idx}
                      className="px-3 py-1 rounded-xl bg-slate-100 border border-slate-200 text-slate-800 text-xs font-semibold"
                    >
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Error Message Container */}
            {errorMsg && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* STEP 1: INITIAL UNLOCK CONTACTS BUTTON */}
            {step === 'details' && (
              <button
                onClick={handleStartUnlock}
                disabled={isCreatingOrder}
                className="w-full py-3.5 rounded-2xl bg-[#800020] hover:bg-[#990011] text-white font-extrabold text-sm shadow-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                {isCreatingOrder ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                    <span>Creating Payment Order...</span>
                  </>
                ) : (
                  <>
                    <Unlock className="w-4 h-4 text-white" />
                    <span>Unlock Contacts (ETB {space.unlock_fee})</span>
                  </>
                )}
              </button>
            )}

            {/* STEP 2: PAYMENT HAND-OFF & RECEIPT VERIFICATION */}
            {step === 'payment' && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4 p-4 rounded-2xl bg-slate-50 border border-slate-200 shadow-sm"
              >
                <div className="flex items-center justify-between pb-3 border-b border-slate-200">
                  <h3 className="font-extrabold text-sm text-slate-900">Complete Contact Unlock</h3>
                  <span className="text-xs text-[#800020] font-black">ETB {space.unlock_fee}</span>
                </div>

                {/* Return to Bot Button */}
                {botPayUrl && (
                  <a
                    href={botPayUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-md transition-all active:scale-95"
                  >
                    <Send className="w-4 h-4" />
                    <span>Return to Telegram Bot to Pay</span>
                  </a>
                )}

                <div className="relative flex py-1 items-center">
                  <div className="flex-grow border-t border-slate-300"></div>
                  <span className="flex-shrink mx-3 text-[10px] text-slate-400 font-bold uppercase">or verify telebirr receipt in app</span>
                  <div className="flex-grow border-t border-slate-300"></div>
                </div>

                {/* Telebirr Platform Account Number */}
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-600 font-semibold">Telebirr Merchant Account Number</label>
                  <div className="flex items-center justify-between p-3 rounded-xl bg-white border border-slate-200 shadow-sm">
                    <span className="font-mono text-base font-extrabold text-slate-900">{receiverPhone}</span>
                    <button
                      onClick={copyPhone}
                      className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                {/* TxRef Input */}
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-600 font-semibold">Telebirr Transaction Reference Number</label>
                  <input
                    type="text"
                    value={txRefInput}
                    onChange={(e) => setTxRefInput(e.target.value)}
                    placeholder="e.g. 9AC4827X19"
                    className="w-full p-3 rounded-xl bg-white border border-slate-300 focus:border-rose-500 focus:outline-none text-xs font-mono font-bold text-slate-900 placeholder-slate-400 shadow-sm"
                  />
                </div>

                {/* Verify Receipt Button */}
                <button
                  onClick={handleVerifyReceipt}
                  disabled={isVerifying || !txRefInput.trim()}
                  className="w-full py-3.5 rounded-xl bg-[#800020] hover:bg-[#990011] text-white font-extrabold text-xs shadow-md disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                >
                  {isVerifying ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-white" />
                      <span>Verifying Receipt with verify.et...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-white" />
                      <span>Verify Receipt & Unlock Immediately</span>
                    </>
                  )}
                </button>
              </motion.div>
            )}

            {/* STEP 3: UNLOCKED CONTACT & LOCATION DATA */}
            {step === 'unlocked' && unlockedData && (
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="space-y-4 p-5 rounded-2xl bg-emerald-50 border border-emerald-300 shadow-sm"
              >
                <div className="flex items-center gap-2 text-emerald-900 text-sm font-extrabold pb-2 border-b border-emerald-200">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  <span>Verified & Unlocked Successfully!</span>
                </div>

                {/* Address */}
                <div className="space-y-0.5">
                  <span className="text-[10px] text-slate-500 font-bold uppercase">Exact Location Address</span>
                  <p className="text-xs font-bold text-slate-900">{unlockedData.exact_address}</p>
                </div>

                {/* Host Info */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="p-3 rounded-xl bg-white border border-slate-200 space-y-0.5">
                    <span className="text-[10px] text-slate-500 font-semibold">Homeowner</span>
                    <p className="text-xs font-bold text-slate-900">{unlockedData.contact_name}</p>
                  </div>

                  <div className="p-3 rounded-xl bg-white border border-slate-200 space-y-0.5">
                    <span className="text-[10px] text-slate-500 font-semibold">Phone Number</span>
                    <p className="text-xs font-mono font-bold text-emerald-700">{unlockedData.contact_phone}</p>
                  </div>
                </div>

                {/* Call & Telegram Buttons */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <a
                    href={`tel:${unlockedData.contact_phone}`}
                    className="py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-all active:scale-95"
                  >
                    <Phone className="w-4 h-4" />
                    <span>Call Host</span>
                  </a>

                  {unlockedData.contact_telegram ? (
                    <a
                      href={`https://t.me/${unlockedData.contact_telegram.replace('@', '')}`}
                      target="_blank"
                      rel="noreferrer"
                      className="py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-all active:scale-95"
                    >
                      <MessageCircle className="w-4 h-4" />
                      <span>Telegram DM</span>
                    </a>
                  ) : (
                    <div className="py-3 px-4 rounded-xl bg-slate-200 text-slate-500 text-xs font-medium flex items-center justify-center">
                      No Telegram DM
                    </div>
                  )}
                </div>

                {/* Google Maps Directions */}
                {unlockedData.latitude && unlockedData.longitude && (
                  <a
                    href={`https://www.google.com/maps?q=${unlockedData.latitude},${unlockedData.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="w-full py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-md transition-all active:scale-95"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>Open Directions on Google Maps</span>
                  </a>
                )}
              </motion.div>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
