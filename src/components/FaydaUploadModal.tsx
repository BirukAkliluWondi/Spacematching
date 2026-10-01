'use client';

import React, { useState } from 'react';
import imageCompression from 'browser-image-compression';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldCheck, Upload, AlertCircle, CheckCircle, Clock, X, FileText, Loader2, Lock } from 'lucide-react';

interface FaydaUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  telegramId: number;
  faydaStatus: 'pending' | 'verified' | 'rejected' | string;
  onUploadSuccess: (filePath: string) => void;
}

export function FaydaUploadModal({
  isOpen,
  onClose,
  telegramId,
  faydaStatus,
  onUploadSuccess,
}: FaydaUploadModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [currentStatus, setCurrentStatus] = useState<string>(faydaStatus);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setIsCompressing(true);

    try {
      const options = {
        maxSizeMB: 0.3,
        maxWidthOrHeight: 1200,
        useWebWorker: true,
        fileType: 'image/webp',
      };

      const compressedBlob = await imageCompression(file, options);
      const compressedFile = new File(
        [compressedBlob],
        `fayda_${Date.now()}.webp`,
        { type: 'image/webp' }
      );

      setSelectedFile(compressedFile);
      setPreviewUrl(URL.createObjectURL(compressedFile));
    } catch (err: unknown) {
      console.error('Compression failed:', err);
      setErrorMsg('Failed to compress image. Please select a valid photo.');
    } finally {
      setIsCompressing(false);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    setErrorMsg(null);
    setUploadProgress(20);

    try {
      const res = await fetch('/api/user/fayda-upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: telegramId,
          file_extension: 'webp',
        }),
      });

      setUploadProgress(50);
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to generate upload URL.');
      }

      setUploadProgress(75);
      const uploadRes = await fetch(data.signed_upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/webp',
        },
        body: selectedFile,
      });

      if (!uploadRes.ok) {
        throw new Error(`Direct storage upload failed (Status ${uploadRes.status})`);
      }

      setUploadProgress(100);
      setCurrentStatus('pending');
      onUploadSuccess(data.file_path);

      setTimeout(() => {
        setIsUploading(false);
        setUploadProgress(0);
      }, 600);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Upload Error:', msg);
      setErrorMsg(msg || 'Identity document upload failed.');
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Dark Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-slate-950/85 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="relative w-full max-w-md rounded-3xl bg-[#0D1424] p-6 shadow-2xl border border-white/10 z-10 text-white space-y-4"
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-md">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-black text-base text-white">Fayda ID Verification</h3>
                <p className="text-[11px] text-slate-400">Official Ethiopian National ID Verification</p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-full bg-white/[0.06] hover:bg-white/10 text-slate-300 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Verification Status Alert Banner */}
          {currentStatus === 'verified' ? (
            <div className="p-4 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center gap-3">
              <CheckCircle className="w-6 h-6 text-emerald-400 shrink-0" />
              <div>
                <h4 className="font-bold text-sm text-emerald-300">Identity Verified</h4>
                <p className="text-xs text-slate-300">Your Fayda National ID is verified and active.</p>
              </div>
            </div>
          ) : currentStatus === 'pending' && !selectedFile ? (
            <div className="p-4 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center gap-3">
              <Clock className="w-6 h-6 text-amber-400 shrink-0" />
              <div>
                <h4 className="font-bold text-sm text-amber-300">Verification Under Review</h4>
                <p className="text-xs text-slate-300">Your document has been submitted and is currently being verified.</p>
              </div>
            </div>
          ) : null}

          {/* Error Message */}
          {errorMsg && (
            <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Document Upload Area */}
          <div className="space-y-3">
            <label className="block text-xs font-bold text-slate-300">
              Upload Front Photo of Fayda ID / Passport:
            </label>

            <div className="relative border-2 border-dashed border-white/15 hover:border-emerald-500/50 rounded-2xl p-6 text-center bg-white/[0.03] transition-colors group cursor-pointer">
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                disabled={isCompressing || isUploading}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />

              {previewUrl ? (
                <div className="space-y-2">
                  <div className="relative w-full h-36 rounded-xl overflow-hidden border border-white/10 mx-auto max-w-xs">
                    <img src={previewUrl} alt="ID Preview" className="w-full h-full object-cover" />
                  </div>
                  <p className="text-[11px] text-emerald-400 font-bold">Photo ready for encrypted upload</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center mx-auto group-hover:scale-110 transition-transform">
                    {isCompressing ? <Loader2 className="w-6 h-6 animate-spin" /> : <Upload className="w-6 h-6" />}
                  </div>
                  <p className="text-xs font-bold text-white">Tap to upload or take a photo</p>
                  <p className="text-[10px] text-slate-400">PNG, JPG, WebP supported (Auto-compressed to &lt;300KB)</p>
                </div>
              )}
            </div>
          </div>

          {/* Encryption Note */}
          <div className="flex items-center gap-2 text-[10px] text-slate-400 bg-white/[0.03] p-3 rounded-xl border border-white/[0.06]">
            <Lock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Your document is encrypted and accessible only to verification admins.</span>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={onClose}
              disabled={isUploading}
              className="flex-1 py-3 rounded-2xl bg-white/[0.06] hover:bg-white/10 text-slate-300 font-bold text-xs border border-white/10"
            >
              Cancel
            </button>

            <button
              onClick={handleUpload}
              disabled={!selectedFile || isUploading || isCompressing}
              className="flex-1 py-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs shadow-xl shadow-emerald-500/25 flex items-center justify-center gap-2 disabled:opacity-50 transition-all active:scale-95"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                  <span>Uploading ({uploadProgress}%)...</span>
                </>
              ) : (
                <span>Submit Verification</span>
              )}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
