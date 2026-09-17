'use client';

import React, { useEffect, useState } from 'react';
import { FeedView, SpaceSummary } from '@/components/FeedView';
import { SpaceDetailSheet } from '@/components/SpaceDetailSheet';
import { FaydaUploadModal } from '@/components/FaydaUploadModal';
import { ShieldAlert } from 'lucide-react';

const FALLBACK_SPACES: SpaceSummary[] = [
  {
    id: '73d7815e-c01b-4b0d-9bf4-9668cffcdd73',
    title: 'Hdhhd',
    description: 'Jdjjd',
    price_per_month: 25,
    unlock_fee: 50,
    neighborhood: 'Jdjjd',
    amenities: [],
    rules: [],
    status: 'published',
    contact_name: 'Biruk ade',
    created_at: new Date().toISOString(),
    space_images: [
      {
        id: 'img-approved',
        image_path: 'https://lzatfklszrovfqoyufnt.supabase.co/storage/v1/object/public/spaces-public/space_test_1789656866406.jpg',
        display_order: 0,
      },
    ],
  },
  {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    title: 'Modern Single Studio Room in Bole Atlas',
    description: 'Cozy, fully furnished room with private bathroom, high-speed WiFi, 24/7 security, and generator back-up. Walking distance to Edna Mall.',
    price_per_month: 12500,
    unlock_fee: 100,
    neighborhood: 'Bole Atlas',
    amenities: ['WiFi', 'Furnished', 'Private Bath', 'Backup Generator', 'Parking'],
    rules: ['No smoking', 'Quiet hours after 10 PM', 'No pets'],
    status: 'published',
    contact_name: 'Solomon Kebede',
    created_at: new Date(Date.now() - 3600000).toISOString(),
    space_images: [
      {
        id: 'img1',
        image_path: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=800&q=80',
        display_order: 1,
      },
    ],
  },
  {
    id: 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
    title: 'Spacious Master Bedroom in Kazanchis',
    description: 'Sunlit room with balcony, dedicated workspace, shared kitchen, and water tanker. Located near UNECA and Intercontinental Hotel.',
    price_per_month: 15000,
    unlock_fee: 150,
    neighborhood: 'Kazanchis',
    amenities: ['WiFi', 'Balcony', 'Workspace', 'Shared Kitchen', 'Hot Shower'],
    rules: ['Professional renters preferred', 'No overnight unregistered guests'],
    status: 'published',
    contact_name: 'Marta Tadesse',
    created_at: new Date(Date.now() - 7200000).toISOString(),
    space_images: [
      {
        id: 'img2',
        image_path: 'https://images.unsplash.com/photo-1598928506311-c55ded91a20c?auto=format&fit=crop&w=800&q=80',
        display_order: 1,
      },
    ],
  },
];

export default function Home() {
  const [telegramUser, setTelegramUser] = useState<any>(null);
  const [faydaStatus, setFaydaStatus] = useState<string>('pending');
  const [spaces, setSpaces] = useState<SpaceSummary[]>(FALLBACK_SPACES);
  const [isLoadingSpaces, setIsLoadingSpaces] = useState<boolean>(false);
  const [selectedSpace, setSelectedSpace] = useState<SpaceSummary | null>(null);
  const [isFaydaModalOpen, setIsFaydaModalOpen] = useState<boolean>(false);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(false);

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
          setTelegramUser({
            id: 123456789,
            first_name: 'Guest Renter',
            username: 'guest_renter',
          });
        }
      } catch (err) {
        console.error('TMA Auth Error:', err);
      } finally {
        setIsAuthLoading(false);
      }
    }

    initTelegramApp();
  }, []);

  // Fetch Public Curated Spaces List from Server
  useEffect(() => {
    async function fetchSpaces() {
      try {
        const res = await fetch('/api/spaces');
        const data = await res.json();
        if (data.success && Array.isArray(data.spaces) && data.spaces.length > 0) {
          setSpaces(data.spaces);
        }
      } catch (err) {
        console.error('Failed to fetch live spaces:', err);
      } finally {
        setIsLoadingSpaces(false);
      }
    }

    fetchSpaces();
  }, []);

  // Detect Telegram Mini App Deep Link (startapp=listing_{id} or start_param=listing_{id})
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const tg = (window as any).Telegram?.WebApp;
    const startParam: string = tg?.initDataUnsafe?.start_param || '';

    const searchParams = new URLSearchParams(window.location.search);
    const urlParam = searchParams.get('startapp') || searchParams.get('tgWebAppStartParam') || '';
    const paramToUse = startParam || urlParam;

    if (paramToUse.startsWith('listing_')) {
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

  const currentTelegramId = telegramUser?.telegram_id || telegramUser?.id || 123456789;

  return (
    <div className="min-h-screen bg-[#EBECEF] text-slate-900 flex justify-center selection:bg-rose-500 selection:text-white">
      <div className="w-full max-w-md sm:max-w-lg min-h-screen bg-[#F5F5F7] shadow-2xl border-x border-slate-300/60 relative flex flex-col">
      {/* Top Fayda ID Banner */}
      {faydaStatus !== 'verified' && !isAuthLoading && (
        <div className="sticky top-0 z-40 bg-gradient-to-r from-amber-600/90 to-amber-500/90 backdrop-blur-md px-4 py-2 text-xs font-medium text-slate-950 flex items-center justify-between shadow-md">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 shrink-0 text-slate-950" />
            <span>Fayda ID Required: Upload National ID to unlock rooms</span>
          </div>
          <button
            onClick={() => setIsFaydaModalOpen(true)}
            className="px-2.5 py-1 rounded-lg bg-slate-950 text-amber-400 font-bold hover:bg-slate-900 transition-colors shadow-sm text-[11px]"
          >
            Upload ID
          </button>
        </div>
      )}

      {/* Main Feed View */}
      <FeedView
        spaces={spaces}
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

      {/* Fayda Upload Modal */}
      <FaydaUploadModal
        isOpen={isFaydaModalOpen}
        onClose={() => setIsFaydaModalOpen(false)}
        telegramId={currentTelegramId}
        faydaStatus={faydaStatus}
        onUploadSuccess={() => {
          setFaydaStatus('pending');
        }}
      />
      </div>
    </div>
  );
}
