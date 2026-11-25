'use client';

import React, { useEffect, useState } from 'react';
import { FeedView, SpaceSummary, RoommateSeekerSummary } from '@/components/FeedView';
import { SpaceDetailSheet } from '@/components/SpaceDetailSheet';
import { FaydaQRScannerModal } from '@/components/FaydaQRScannerModal';

export default function Home() {
  const [telegramUser, setTelegramUser] = useState<any>(null);
  const [faydaStatus, setFaydaStatus] = useState<string>('pending');
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [seekers, setSeekers] = useState<RoommateSeekerSummary[]>([]);
  const [isLoadingSpaces, setIsLoadingSpaces] = useState<boolean>(true);
  const [selectedSpace, setSelectedSpace] = useState<SpaceSummary | null>(null);
  const [isFaydaModalOpen, setIsFaydaModalOpen] = useState<boolean>(false);

  // Initialize Telegram Mini App & Authenticate User
  useEffect(() => {
    async function initTelegramApp() {
      if (typeof window === 'undefined') return;

      const tg = (window as any).Telegram?.WebApp;
      if (tg) {
        try {
          tg.ready();
          tg.expand();
        } catch (e) {
          console.error('TMA SDK init error:', e);
        }
      }

      const initData = tg?.initData || '';
      const unsafeUser = tg?.initDataUnsafe?.user;

      try {
        if (initData) {
          const res = await fetch('/api/auth/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData }),
          });

          const data = await res.json();
          if (data.success && data.user) {
            setTelegramUser(data.user);
            setFaydaStatus(data.user.fayda_status || 'pending');
          } else if (unsafeUser) {
            setTelegramUser({
              telegram_id: unsafeUser.id,
              first_name: unsafeUser.first_name || 'User',
              username: unsafeUser.username || null,
            });
          }
        } else if (unsafeUser) {
          setTelegramUser({
            telegram_id: unsafeUser.id,
            first_name: unsafeUser.first_name || 'User',
            username: unsafeUser.username || null,
          });
        } else {
          setTelegramUser(null);
        }
      } catch (err) {
        console.error('TMA Auth Error:', err);
      }
    }

    initTelegramApp();
  }, []);

  // Fetch Public Curated Spaces & Roommates List from Server
  useEffect(() => {
    async function fetchAppData() {
      try {
        setIsLoadingSpaces(true);
        const [spacesRes, roommatesRes] = await Promise.all([
          fetch('/api/spaces'),
          fetch('/api/roommates'),
        ]);

        const spacesData = await spacesRes.json();
        if (spacesData.success && Array.isArray(spacesData.spaces) && spacesData.spaces.length > 0) {
          setSpaces(spacesData.spaces);
        }

        const roommatesData = await roommatesRes.json();
        if (roommatesData.success && Array.isArray(roommatesData.seekers) && roommatesData.seekers.length > 0) {
          setSeekers(roommatesData.seekers);
        }
      } catch (err) {
        console.error('Failed to fetch live app data:', err);
      } finally {
        setIsLoadingSpaces(false);
      }
    }

    fetchAppData();
  }, []);

  // Detect Telegram Mini App Deep Link
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const tg = (window as any).Telegram?.WebApp;
    const startParam: string = tg?.initDataUnsafe?.start_param || '';

    const searchParams = new URLSearchParams(window.location.search);
    const urlParam = searchParams.get('startapp') || searchParams.get('tgWebAppStartParam') || '';
    const paramToUse = startParam || urlParam;

    if (paramToUse === 'verify_fayda' || paramToUse.startsWith('verify_fayda')) {
      setIsFaydaModalOpen(true);
    } else if (paramToUse.startsWith('listing_')) {
      const listingId = paramToUse.replace('listing_', '').trim();
      if (listingId) {
        const target = spaces.find((s) => s.id === listingId);
        if (target) {
          setSelectedSpace(target);
        } else {
          fetch('/api/spaces')
            .then((r) => r.json())
            .then((d) => {
              if (d.success && Array.isArray(d.spaces)) {
                const found = d.spaces.find((item: any) => item.id === listingId);
                if (found) setSelectedSpace(found);
              }
            })
            .catch((e) => console.error('Error fetching deep-linked space:', e));
        }
      }
    }
  }, [spaces]);

  const handleSelectSpace = (spaceId: string) => {
    const target = spaces.find((s) => s.id === spaceId);
    if (target) {
      setSelectedSpace(target);
    }
  };

  const currentTelegramId = telegramUser?.telegram_id || telegramUser?.id || 0;

  return (
    <div className="min-h-screen bg-[#EBECEF] text-slate-900 flex justify-center selection:bg-rose-500 selection:text-white">
      <div className="w-full max-w-md sm:max-w-lg min-h-screen bg-[#F5F5F7] shadow-2xl border-x border-slate-300/60 relative flex flex-col">
        {/* Main Feed View */}
        <FeedView
          spaces={spaces}
          seekers={seekers}
          isLoading={isLoadingSpaces}
          onSelectSpace={handleSelectSpace}
          botUsername={process.env.NEXT_PUBLIC_BOT_USERNAME || 'Spacematchaddis_bot'}
          onOpenFaydaModal={() => setIsFaydaModalOpen(true)}
          faydaStatus={faydaStatus}
        />

        {/* Space Detail Sheet Drawer */}
        <SpaceDetailSheet
          space={selectedSpace}
          onClose={() => setSelectedSpace(null)}
          telegramId={currentTelegramId}
        />

        {/* Native Fayda QR Scanner Modal */}
        <FaydaQRScannerModal
          isOpen={isFaydaModalOpen}
          onClose={() => setIsFaydaModalOpen(false)}
          telegramId={currentTelegramId}
          faydaStatus={faydaStatus}
          onVerificationSuccess={(data) => {
            setFaydaStatus('verified');
            if (telegramUser) {
              setTelegramUser({
                ...telegramUser,
                fayda_status: 'verified',
                fayda_number: data.faydaNumber,
              });
            }
          }}
        />
      </div>
    </div>
  );
}
