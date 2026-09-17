'use client';

import React, { useState } from 'react';
import imageCompression from 'browser-image-compression';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldCheck, Upload, AlertCircle, CheckCircle, Clock, X, FileText, Loader2 } from 'lucide-react';

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
      // 1. Device-side compression options (WebP, <= 300KB)
      const options = {
        maxSizeMB: 0.3, // 300KB
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
      // 2. Request presigned upload URL from API
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

      // 3. Upload directly to Supabase Storage via PUT
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
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-slate-950/80 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="relative w-full max-w-md rounded-2xl glass-panel p-6 shadow-2xl border border-white/10 z-10 text-white"
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-lg text-white">Fayda ID Verification</h3>
                <p className="text-xs text-slate-400">Required identity upload for renters</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Current Verification Status */}
          <div className="my-4">
            {currentStatus === 'verified' && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-sm">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span>Fayda ID is <strong>Verified</strong>.</span>
              </div>
            )}
            {currentStatus === 'pending' && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-sm">
                <Clock className="w-4 h-4 shrink-0 animate-pulse" />
                <span>Verification <strong>Pending Review</strong> by admin team.</span>
              </div>
            )}
            {currentStatus === 'rejected' && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-400 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>ID Rejected. Please re-upload a clean photo of your ID.</span>
              </div>
            )}
          </div>

          {/* Upload Box */}
          <div className="space-y-4">
            <div className="relative border-2 border-dashed border-slate-700 hover:border-indigo-500/50 rounded-2xl p-6 text-center bg-slate-900/40 transition-colors group">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
                disabled={isCompressing || isUploading}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
              />

              {previewUrl ? (
                <div className="space-y-3">
                  <img
                    src={previewUrl}
                    alt="Fayda ID Preview"
                    className="max-h-40 mx-auto rounded-xl object-contain border border-white/10 shadow-md"
                  />
                  <p className="text-xs text-slate-400">
                    WebP Size: {(selectedFile!.size / 1024).toFixed(1)} KB (Target &lt; 300KB)
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto text-slate-400 group-hover:text-indigo-400 group-hover:bg-indigo-500/20 transition-all">
                    <Upload className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-medium text-slate-300">
                    Tap to upload your Fayda National ID
                  </p>
                  <p className="text-xs text-slate-500">
                    Auto-compressed to WebP under 300KB
                  </p>
                </div>
              )}
            </div>

            {/* Error Message */}
            {errorMsg && (
              <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 p-2.5 rounded-lg flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Upload Progress Bar */}
            {isUploading && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-slate-400">
                  <span>Uploading to identity vault...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                  <motion.div
                    className="h-full bg-indigo-500"
                    initial={{ width: 0 }}
                    animate={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Action Button */}
            <button
              onClick={handleUpload}
              disabled={!selectedFile || isCompressing || isUploading}
              className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-medium shadow-lg glow-indigo disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {isCompressing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Compressing Image...</span>
                </>
              ) : isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Uploading ID Document...</span>
                </>
              ) : (
                <>
                  <FileText className="w-4 h-4" />
                  <span>Submit Fayda ID</span>
                </>
              )}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
