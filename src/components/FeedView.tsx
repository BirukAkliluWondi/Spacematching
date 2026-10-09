'use client';

import React, { useState, useMemo } from 'react';
import {
  Search,
  Heart,
  MapPin,
  Sparkles,
  ArrowUpDown,
  Filter,
  Home,
  Building2,
  Users,
  ShoppingBag,
  User,
  Plus,
  Clock,
  ArrowRight,
  ShieldCheck,
  Star,
  Unlock,
  Store,
  Layers,
  CheckCircle2,
  PhoneCall,
  Sparkle,
  UserCheck,
  ShieldAlert,
} from 'lucide-react';

export interface SpaceSummary {
  id: string;
  title: string;
  description: string;
  price_per_month: number;
  unlock_fee: number;
  neighborhood: string;
  amenities: string[];
  rules: string[];
  status: string;
  contact_name: string;
  created_at: string;
  space_images: Array<{
    id: string;
    image_path: string;
    display_order: number;
  }>;
}

export interface RoommateSeekerSummary {
  id: string;
  first_name: string;
  preferred_subcity: string[];
  my_gender: string;
  preferred_gender: string;
  budget_max: number;
  lifestyle_bio: string;
  fayda_status: 'unverified' | 'pending' | 'verified' | 'rejected';
  unlock_fee: number;
  created_at: string;
}

interface FeedViewProps {
  spaces: SpaceSummary[];
  seekers?: RoommateSeekerSummary[];
  isLoading: boolean;
  onSelectSpace: (spaceId: string) => void;
  botUsername?: string;
  onOpenFaydaModal?: () => void;
  faydaStatus?: string;
}

const FALLBACK_SEEKERS: RoommateSeekerSummary[] = [
  {
    id: 'seeker-1',
    first_name: 'Helina',
    preferred_subcity: ['Bole', 'Kazanchis'],
    my_gender: 'Female',
    preferred_gender: 'Female',
    budget_max: 12000,
    lifestyle_bio: 'Software Developer working at Kazanchis. Quiet, non-smoker, clean. Looking to share a 2-bedroom condo.',
    fayda_status: 'verified',
    unlock_fee: 50,
    created_at: new Date().toISOString(),
  },
  {
    id: 'seeker-2',
    first_name: 'Amanuel',
    preferred_subcity: ['CMC', 'Sarbet'],
    my_gender: 'Male',
    preferred_gender: 'Male',
    budget_max: 9500,
    lifestyle_bio: 'Civil Engineer, loves gaming and coffee. Looking for a friendly roommate to split rent.',
    fayda_status: 'verified',
    unlock_fee: 50,
    created_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 'seeker-3',
    first_name: 'Selam',
    preferred_subcity: ['Piassa', '4 Kilo'],
    my_gender: 'Female',
    preferred_gender: 'Any',
    budget_max: 10000,
    lifestyle_bio: 'Postgrad student at AAU. Respectful, tidy, move-in target by Nov 1.',
    fayda_status: 'pending',
    unlock_fee: 50,
    created_at: new Date(Date.now() - 7200000).toISOString(),
  },
];

export function FeedView({
  spaces,
  seekers = FALLBACK_SEEKERS,
  isLoading,
  onSelectSpace,
  botUsername = 'Spacematchaddis_bot',
  onOpenFaydaModal,
  faydaStatus = 'pending',
}: FeedViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMainTab, setActiveMainTab] = useState<'seekers' | 'spaces'>('seekers');
  const [sortOrder, setSortOrder] = useState<'newest' | 'price_asc' | 'price_desc'>('newest');
  const [activeTab, setActiveTab] = useState<'home' | 'wishlist' | 'orders' | 'account'>('home');
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [selectedSubcityFilter, setSelectedSubcityFilter] = useState<string>('All');

  const toggleSave = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSavedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const filteredSeekers = useMemo(() => {
    let list = [...seekers];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (s) =>
          s.first_name.toLowerCase().includes(q) ||
          s.lifestyle_bio.toLowerCase().includes(q) ||
          s.preferred_subcity.some((sub) => sub.toLowerCase().includes(q))
      );
    }

    if (selectedSubcityFilter !== 'All') {
      list = list.filter((s) => s.preferred_subcity.includes(selectedSubcityFilter));
    }

    if (sortOrder === 'price_asc') {
      list.sort((a, b) => a.budget_max - b.budget_max);
    } else if (sortOrder === 'price_desc') {
      list.sort((a, b) => b.budget_max - a.budget_max);
    } else {
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    return list;
  }, [seekers, searchQuery, selectedSubcityFilter, sortOrder]);

  const filteredSpaces = useMemo(() => {
    let list = [...spaces];

    if (activeTab === 'wishlist') {
      list = list.filter((item) => savedIds.includes(item.id));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.neighborhood.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q)
      );
    }

    if (sortOrder === 'price_asc') {
      list.sort((a, b) => Number(a.price_per_month) - Number(b.price_per_month));
    } else if (sortOrder === 'price_desc') {
      list.sort((a, b) => Number(b.price_per_month) - Number(a.price_per_month));
    } else {
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    return list;
  }, [spaces, searchQuery, sortOrder, activeTab, savedIds]);

  const cleanBotUrl = `https://t.me/${botUsername.replace('@', '')}`;

  return (
    <div className="min-h-screen bg-[#0A0E17] text-slate-100 pb-32 selection:bg-rose-500 selection:text-white relative overflow-hidden">
      {/* Ambient Background Glowing Orbs */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-rose-500/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute top-1/3 right-0 w-80 h-80 bg-amber-500/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-10 left-0 w-80 h-80 bg-indigo-500/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Top Header */}
      <header className="sticky top-0 z-30 luxury-header px-4 pt-4 pb-3 space-y-3 backdrop-blur-xl bg-[#0A0E17]/80 border-b border-white/10">
        {/* Top Row: Brand & Post Seeker Action */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-rose-500 to-amber-400 text-slate-950 flex items-center justify-center font-black text-lg shadow-lg shadow-rose-500/20">
              SM
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-black text-base tracking-tight text-white">SpaceMatch</h1>
                <span className="px-2 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/40 text-[9px] font-bold text-rose-400">
                  Roommate-First
                </span>
              </div>
              <p className="text-[11px] text-slate-400 flex items-center gap-1">
                <MapPin className="w-3 h-3 text-rose-400" />
                <span>Addis Ababa • Verified Fayda ID</span>
              </p>
            </div>
          </div>

          <a
            href={`${cleanBotUrl}?start=seeker_flow`}
            target="_blank"
            rel="noreferrer"
            className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-rose-500 to-amber-500 hover:from-rose-400 hover:to-amber-400 text-slate-950 font-black text-xs shadow-lg shadow-rose-500/25 transition-all active:scale-95 flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            <span>Post Seeker</span>
          </a>
        </div>

        {/* Primary Tab Toggle (Roommate Seekers vs Spaces to Rent) */}
        <div className="grid grid-cols-2 p-1 rounded-2xl bg-white/[0.06] border border-white/10 text-xs font-bold">
          <button
            onClick={() => setActiveMainTab('seekers')}
            className={`py-2.5 rounded-xl transition-all flex items-center justify-center gap-2 ${
              activeMainTab === 'seekers'
                ? 'bg-gradient-to-r from-rose-500 to-amber-500 text-slate-950 shadow-lg shadow-rose-500/20 font-black'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>👥 Roommate Seekers ({seekers.length})</span>
          </button>

          <button
            onClick={() => setActiveMainTab('spaces')}
            className={`py-2.5 rounded-xl transition-all flex items-center justify-center gap-2 ${
              activeMainTab === 'spaces'
                ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 shadow-lg shadow-emerald-500/20 font-black'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Home className="w-4 h-4" />
            <span>🏠 Spaces to Rent ({spaces.length})</span>
          </button>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={
              activeMainTab === 'seekers'
                ? 'Search sub-city, bio, or preferred roommate...'
                : 'Search sub-city, price, or room type...'
            }
            className="w-full pl-11 pr-4 py-3 rounded-2xl bg-white/[0.05] border border-white/10 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-rose-500/40 focus:border-rose-500/50 backdrop-blur-xl transition-all shadow-inner"
          />
        </div>

        {/* Sub-city Quick Filter Chips */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-1 pb-1">
          {['All', 'Bole', 'Kazanchis', 'CMC', 'Sarbet', 'Piassa', '4 Kilo'].map((sub) => {
            const isActive = selectedSubcityFilter === sub;
            return (
              <button
                key={sub}
                onClick={() => setSelectedSubcityFilter(sub)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0 flex items-center gap-1 ${
                  isActive
                    ? 'bg-rose-500 text-slate-950 shadow-md shadow-rose-500/20'
                    : 'bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] border border-white/[0.06]'
                }`}
              >
                <MapPin className="w-3 h-3" />
                <span>{sub}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="px-4 pt-4 space-y-4 relative z-10">
        {activeMainTab === 'seekers' ? (
          /* ================================================================= */
          /* PRIMARY TAB: ROOMMATE SEEKERS                                     */
          /* ================================================================= */
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Showing <strong>{filteredSeekers.length}</strong> verified roommate seekers</span>
              <span className="text-[10px] text-rose-400 font-bold bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/20">
                🛡️ Fayda Verified First
              </span>
            </div>

            {filteredSeekers.length === 0 ? (
              <div className="py-16 text-center space-y-3 luxury-card rounded-3xl p-6 text-slate-300">
                <Users className="w-10 h-10 text-rose-400 mx-auto" />
                <h4 className="font-black text-base text-white">No Roommate Seekers Found</h4>
                <p className="text-xs text-slate-400">Be the first to post your roommate preference on the channel!</p>
                <a
                  href={`${cleanBotUrl}?start=seeker_flow`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block mt-2 px-4 py-2 rounded-xl bg-rose-500 text-slate-950 font-black text-xs shadow-lg shadow-rose-500/20"
                >
                  Post Your Seeker Profile
                </a>
              </div>
            ) : (
              filteredSeekers.map((seeker) => (
                <div
                  key={seeker.id}
                  className="luxury-card rounded-3xl p-4 bg-gradient-to-br from-[#161D2B]/90 via-[#111724]/90 to-[#0F1420]/90 border border-white/10 shadow-xl space-y-3 hover:border-rose-500/40 transition-all"
                >
                  {/* Seeker Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-rose-500 to-amber-500 text-slate-950 font-black text-base flex items-center justify-center shadow-md">
                        {seeker.first_name[0]}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-sm text-white">{seeker.first_name}</h3>
                          {seeker.fayda_status === 'verified' && (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-[9px] font-black text-emerald-400 flex items-center gap-1">
                              <ShieldCheck className="w-3 h-3 text-emerald-400" />
                              Fayda ID Verified
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400">
                          {seeker.my_gender} • Seeking {seeker.preferred_gender} Roommate
                        </p>
                      </div>
                    </div>

                    <span className="text-sm font-black text-rose-400">
                      ETB {seeker.budget_max.toLocaleString()}
                      <span className="text-[10px] font-normal text-slate-400">/mo</span>
                    </span>
                  </div>

                  {/* Sub-cities & Lifestyle Bio */}
                  <div className="space-y-2 pt-1 border-t border-white/[0.06]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-slate-400 font-bold">Preferred Sub-Cities:</span>
                      {seeker.preferred_subcity.map((sub) => (
                        <span
                          key={sub}
                          className="px-2 py-0.5 rounded-md bg-white/[0.06] text-[10px] font-semibold text-slate-300 border border-white/10"
                        >
                          📍 {sub}
                        </span>
                      ))}
                    </div>

                    <p className="text-xs text-slate-300 italic line-clamp-3 bg-white/[0.02] p-2.5 rounded-xl border border-white/[0.04]">
                      &quot;{seeker.lifestyle_bio}&quot;
                    </p>
                  </div>

                  {/* Unlock Contact Button */}
                  <a
                    href={`${cleanBotUrl}?start=unlock_seeker_${seeker.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-rose-500 to-amber-500 hover:from-rose-400 hover:to-amber-400 text-slate-950 font-black text-xs shadow-lg shadow-rose-500/20 flex items-center justify-center gap-2 transition-all active:scale-95"
                  >
                    <Unlock className="w-4 h-4" />
                    <span>Unlock Contact Info ({seeker.unlock_fee || 50} ETB via Telebirr)</span>
                  </a>
                </div>
              ))
            )}
          </div>
        ) : (
          /* ================================================================= */
          /* SECONDARY TAB: SPACES FOR RENT (HOMEOWNERS)                       */
          /* ================================================================= */
          <div className="grid grid-cols-2 gap-3">
            {filteredSpaces.map((space) => {
              const coverImg =
                space.space_images && space.space_images.length > 0
                  ? space.space_images[0].image_path
                  : 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=600&q=80';

              const isSaved = savedIds.includes(space.id);

              return (
                <div
                  key={space.id}
                  onClick={() => onSelectSpace(space.id)}
                  className="group luxury-card rounded-3xl overflow-hidden transition-all duration-300 cursor-pointer flex flex-col justify-between"
                >
                  <div className="relative w-full h-36 bg-slate-900 overflow-hidden">
                    <img
                      src={coverImg}
                      alt={space.title}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/20 to-transparent" />

                    <button
                      onClick={(e) => toggleSave(e, space.id)}
                      className={`absolute top-2 right-2 p-1.5 rounded-full backdrop-blur-md transition-all active:scale-90 ${
                        isSaved
                          ? 'bg-rose-500 text-white shadow-lg shadow-rose-500/30'
                          : 'bg-slate-950/50 text-slate-300 border border-white/10'
                      }`}
                    >
                      <Heart className={`w-3.5 h-3.5 ${isSaved ? 'fill-current' : ''}`} />
                    </button>
                  </div>

                  <div className="p-3 space-y-2 flex-grow flex flex-col justify-between">
                    <div className="space-y-1">
                      <span className="text-emerald-400 font-black text-xs">
                        ETB {Number(space.price_per_month).toLocaleString()}/mo
                      </span>

                      <h3 className="font-bold text-xs text-white line-clamp-1 leading-snug">
                        {space.title}
                      </h3>

                      <div className="flex items-center gap-1 text-[10px] text-slate-400">
                        <MapPin className="w-3 h-3 text-emerald-400 shrink-0" />
                        <span className="truncate">{space.neighborhood}</span>
                      </div>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectSpace(space.id);
                      }}
                      className="w-full py-2 px-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center justify-center gap-1 transition-all active:scale-95"
                    >
                      <Unlock className="w-3.5 h-3.5" />
                      <span>Unlock Host ({space.unlock_fee || 50} ETB)</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Floating Bottom Dock Navigation */}
      <nav className="fixed bottom-0 w-full max-w-md sm:max-w-lg left-1/2 -translate-x-1/2 z-40 luxury-dock px-6 py-2.5 flex items-center justify-around shadow-2xl backdrop-blur-2xl bg-[#0A0E17]/90 border-t border-white/10">
        <button
          onClick={() => setActiveMainTab('seekers')}
          className={`flex flex-col items-center gap-1 text-[10px] font-bold transition-all ${
            activeMainTab === 'seekers' ? 'text-rose-400 scale-105' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Users className="w-5 h-5" />
          <span>Seekers</span>
        </button>

        <button
          onClick={() => setActiveMainTab('spaces')}
          className={`flex flex-col items-center gap-1 text-[10px] font-bold transition-all ${
            activeMainTab === 'spaces' ? 'text-emerald-400 scale-105' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Home className="w-5 h-5" />
          <span>Spaces</span>
        </button>

        <a
          href={`${cleanBotUrl}?start=seeker_flow`}
          target="_blank"
          rel="noreferrer"
          className="w-12 h-12 rounded-full bg-gradient-to-tr from-rose-500 to-amber-400 text-slate-950 shadow-xl shadow-rose-500/30 flex items-center justify-center -mt-6 hover:scale-110 active:scale-95 transition-transform border-4 border-[#0A0E17]"
          title="Post Seeker Profile"
        >
          <Plus className="w-6 h-6 stroke-[3]" />
        </a>

        <button
          onClick={onOpenFaydaModal}
          className={`flex flex-col items-center gap-1 text-[10px] font-bold transition-all ${
            faydaStatus === 'verified' ? 'text-emerald-400' : 'text-slate-400 hover:text-white'
          }`}
        >
          <UserCheck className="w-5 h-5" />
          <span>Fayda ID</span>
        </button>
      </nav>
    </div>
  );
}
