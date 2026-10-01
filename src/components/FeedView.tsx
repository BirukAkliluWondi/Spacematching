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

interface FeedViewProps {
  spaces: SpaceSummary[];
  isLoading: boolean;
  onSelectSpace: (spaceId: string) => void;
  botUsername?: string;
  onOpenFaydaModal?: () => void;
  faydaStatus?: string;
}

const CATEGORIES = [
  { id: 'All', label: 'All Spaces', icon: Layers },
  { id: 'Shared Rooms', label: 'Shared / Roommates', icon: Users },
  { id: 'Entire House', label: 'Entire Houses', icon: Home },
  { id: 'Commercial', label: 'Offices & Commercial', icon: Building2 },
  { id: 'Shop', label: 'Shops & Warehouses', icon: Store },
];

export function FeedView({
  spaces,
  isLoading,
  onSelectSpace,
  botUsername = 'Spacematchaddis_bot',
  onOpenFaydaModal,
  faydaStatus = 'pending',
}: FeedViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [sortOrder, setSortOrder] = useState<'newest' | 'price_asc' | 'price_desc'>('newest');
  const [activeTab, setActiveTab] = useState<'home' | 'wishlist' | 'orders' | 'account'>('home');
  const [savedIds, setSavedIds] = useState<string[]>([]);

  const toggleSave = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSavedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

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

    if (activeCategory !== 'All') {
      const catLower = activeCategory.toLowerCase();
      list = list.filter((item) => {
        const titleMatch = item.title.toLowerCase().includes(catLower);
        const descMatch = item.description.toLowerCase().includes(catLower);
        const hoodMatch = item.neighborhood.toLowerCase().includes(catLower);
        const amenMatch = item.amenities.some((a) => a.toLowerCase().includes(catLower));
        return titleMatch || descMatch || hoodMatch || amenMatch;
      });
    }

    if (sortOrder === 'price_asc') {
      list.sort((a, b) => Number(a.price_per_month) - Number(b.price_per_month));
    } else if (sortOrder === 'price_desc') {
      list.sort((a, b) => Number(b.price_per_month) - Number(a.price_per_month));
    } else {
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    return list;
  }, [spaces, searchQuery, activeCategory, sortOrder, activeTab, savedIds]);

  const cleanBotUrl = `https://t.me/${botUsername.replace('@', '')}`;
  const spotLightSpace = spaces.length > 0 ? spaces[0] : null;

  return (
    <div className="min-h-screen bg-[#0A0E17] text-slate-100 pb-32 selection:bg-emerald-500 selection:text-white relative overflow-hidden">
      {/* Ambient Background Glowing Orbs */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute top-1/3 right-0 w-80 h-80 bg-amber-500/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute bottom-10 left-0 w-80 h-80 bg-indigo-500/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Top Luxury Header */}
      <header className="sticky top-0 z-30 luxury-header px-4 pt-4 pb-3 space-y-3">
        {/* Top Row: Brand & List Space Action */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 text-slate-950 flex items-center justify-center font-black text-lg shadow-lg shadow-emerald-500/20">
              SM
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="font-black text-base tracking-tight text-white">SpaceMatch</h1>
                <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-[9px] font-bold text-emerald-400">
                  Addis Ababa
                </span>
              </div>
              <p className="text-[11px] text-slate-400 flex items-center gap-1">
                <MapPin className="w-3 h-3 text-emerald-400" />
                <span>Bole • Kazanchis • CMC • Sarbet</span>
              </p>
            </div>
          </div>

          <a
            href={cleanBotUrl}
            target="_blank"
            rel="noreferrer"
            className="px-3.5 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs shadow-lg shadow-emerald-500/25 transition-all active:scale-95 flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            <span>List Space</span>
          </a>
        </div>

        {/* Search Bar Input */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search sub-city, room type, or price..."
            className="w-full pl-11 pr-4 py-3 rounded-2xl bg-white/[0.05] border border-white/10 text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/50 backdrop-blur-xl transition-all shadow-inner"
          />
        </div>

        {/* Categories Bar */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-1 pb-1">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isActive = activeCategory === cat.id;

            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all shrink-0 flex items-center gap-2 ${
                  isActive
                    ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                    : 'bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] border border-white/[0.06]'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        {/* Header Controls: Results Count & Sort Dropdown */}
        <div className="flex items-center justify-between pt-1 border-t border-white/[0.06]">
          <span className="text-xs text-slate-400 font-semibold">
            Showing <strong className="text-white">{filteredSpaces.length}</strong> available spaces
          </span>

          <button
            onClick={() =>
              setSortOrder((prev) =>
                prev === 'newest' ? 'price_asc' : prev === 'price_asc' ? 'price_desc' : 'newest'
              )
            }
            className="px-3 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-slate-200 text-xs font-bold flex items-center gap-1.5 active:scale-95 transition-all"
          >
            <ArrowUpDown className="w-3.5 h-3.5 text-emerald-400" />
            <span className="capitalize">{sortOrder.replace('_', ' ')}</span>
          </button>
        </div>
      </header>

      {/* Main Scroll Content */}
      <main className="px-4 pt-3 space-y-4 relative z-10">
        {/* Featured Spotlight Banner */}
        {spotLightSpace && activeCategory === 'All' && !searchQuery && (
          <div
            onClick={() => onSelectSpace(spotLightSpace.id)}
            className="luxury-card rounded-3xl p-4 bg-gradient-to-br from-[#162238]/90 via-[#111A2C]/90 to-[#0F172A]/90 border border-emerald-500/30 shadow-2xl relative overflow-hidden group cursor-pointer"
          >
            {/* Ambient Lighting Accent */}
            <div className="absolute -top-12 -right-12 w-36 h-36 bg-emerald-500/20 rounded-full blur-2xl group-hover:scale-125 transition-transform" />

            <div className="flex items-center justify-between gap-3 relative z-10">
              <div className="space-y-1.5 max-w-[62%]">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-[10px] font-black text-emerald-300">
                  <Sparkles className="w-3 h-3 text-emerald-400 animate-spin-slow" />
                  <span>SPOTLIGHT PROPERTY</span>
                </div>
                <h3 className="font-black text-base text-white line-clamp-1 leading-tight">
                  {spotLightSpace.title}
                </h3>
                <p className="text-xs text-slate-300 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>{spotLightSpace.neighborhood}</span>
                </p>

                <div className="pt-1 flex items-center gap-2">
                  <span className="text-base font-black text-emerald-400">
                    ETB {Number(spotLightSpace.price_per_month).toLocaleString()}
                    <span className="text-[10px] font-normal text-slate-400">/mo</span>
                  </span>
                </div>
              </div>

              <div className="w-24 h-24 rounded-2xl overflow-hidden relative border border-white/10 shadow-lg shrink-0">
                <img
                  src={
                    spotLightSpace.space_images?.[0]?.image_path ||
                    'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=600&q=80'
                  }
                  alt="Spotlight"
                  className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent" />
              </div>
            </div>
          </div>
        )}

        {/* Listings Grid */}
        <div>
          {isLoading ? (
            <div className="grid grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="luxury-card rounded-3xl p-3 animate-pulse space-y-3">
                  <div className="w-full h-36 rounded-2xl bg-slate-800/60" />
                  <div className="h-4 bg-slate-800/60 rounded w-3/4" />
                  <div className="h-3 bg-slate-800/60 rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : filteredSpaces.length === 0 ? (
            <div className="py-16 text-center space-y-3 luxury-card rounded-3xl p-6 text-slate-300">
              <div className="w-14 h-14 rounded-full bg-slate-800/80 border border-white/10 flex items-center justify-center mx-auto text-slate-400">
                <Search className="w-7 h-7" />
              </div>
              <h4 className="font-black text-base text-white">No spaces found matching filters</h4>
              <p className="text-xs text-slate-400">Try searching for Bole, Kazanchis, Studio, or Shared Room.</p>
              <button
                onClick={() => {
                  setSearchQuery('');
                  setActiveCategory('All');
                }}
                className="mt-2 px-4 py-2 rounded-xl bg-emerald-500 text-slate-950 font-black text-xs shadow-lg shadow-emerald-500/20"
              >
                Clear All Filters
              </button>
            </div>
          ) : (
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
                    {/* Cover Image & Floating Badges */}
                    <div className="relative w-full h-40 bg-slate-900 overflow-hidden">
                      <img
                        src={coverImg}
                        alt={space.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src =
                            'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=600&q=80';
                        }}
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/20 to-transparent" />

                      {/* Top Wishlist Heart */}
                      <button
                        onClick={(e) => toggleSave(e, space.id)}
                        className={`absolute top-2.5 right-2.5 p-2 rounded-full backdrop-blur-md transition-all active:scale-90 ${
                          isSaved
                            ? 'bg-rose-500 text-white shadow-lg shadow-rose-500/30'
                            : 'bg-slate-950/50 text-slate-300 hover:text-white border border-white/10'
                        }`}
                      >
                        <Heart className={`w-3.5 h-3.5 ${isSaved ? 'fill-current' : ''}`} />
                      </button>

                      {/* Verified Instant Unlock Tag */}
                      <div className="absolute bottom-2.5 left-2.5 px-2 py-0.5 rounded-md bg-slate-950/80 backdrop-blur-md border border-white/10 text-[9px] font-bold text-emerald-400 flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
                        <span>Instant Unlock</span>
                      </div>
                    </div>

                    {/* Card Content Info */}
                    <div className="p-3.5 space-y-2 flex-grow flex flex-col justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-emerald-400 font-black text-sm">
                            ETB {Number(space.price_per_month).toLocaleString()}
                            <span className="text-[10px] font-normal text-slate-400">/mo</span>
                          </span>
                        </div>

                        <h3 className="font-bold text-xs text-white line-clamp-1 leading-snug group-hover:text-emerald-300 transition-colors">
                          {space.title}
                        </h3>

                        <div className="flex items-center gap-1 text-[11px] text-slate-400">
                          <MapPin className="w-3 h-3 text-emerald-400 shrink-0" />
                          <span className="truncate">{space.neighborhood}</span>
                        </div>
                      </div>

                      {/* Unlock Action Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectSpace(space.id);
                        }}
                        className="w-full mt-2 py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-1.5 transition-all active:scale-95"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        <span>Unlock Contact</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* Floating Bottom Navigation Dock */}
      <nav className="fixed bottom-0 w-full max-w-md sm:max-w-lg left-1/2 -translate-x-1/2 z-40 luxury-dock px-6 py-2.5 flex items-center justify-around shadow-2xl">
        {/* Home Tab */}
        <button
          onClick={() => setActiveTab('home')}
          className={`flex flex-col items-center gap-1 text-[10px] font-bold transition-all ${
            activeTab === 'home' ? 'text-emerald-400 scale-105' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Home className="w-5 h-5" />
          <span>Home</span>
        </button>

        {/* Wishlist Tab */}
        <button
          onClick={() => setActiveTab('wishlist')}
          className={`flex flex-col items-center gap-1 text-[10px] font-bold relative transition-all ${
            activeTab === 'wishlist' ? 'text-emerald-400 scale-105' : 'text-slate-400 hover:text-white'
          }`}
        >
          <Heart className="w-5 h-5" />
          <span>Wishlist</span>
          {savedIds.length > 0 && (
            <span className="absolute -top-1 -right-2 w-4 h-4 rounded-full bg-rose-500 text-white text-[9px] font-black flex items-center justify-center shadow-md">
              {savedIds.length}
            </span>
          )}
        </button>

        {/* Center Action Button (Raised Pill) */}
        <a
          href={cleanBotUrl}
          target="_blank"
          rel="noreferrer"
          className="w-13 h-13 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-400 text-slate-950 shadow-xl shadow-emerald-500/30 flex items-center justify-center -mt-7 hover:scale-110 active:scale-95 transition-transform border-4 border-[#0A0E17]"
          title="Post Space Listing"
        >
          <Plus className="w-7 h-7 stroke-[3]" />
        </a>

        {/* Orders / Cart Tab */}
        <button
          onClick={() => {
            setActiveTab('orders');
            if (spaces.length > 0) {
              onSelectSpace(spaces[0].id);
            }
          }}
          className={`flex flex-col items-center gap-1 text-[10px] font-bold relative transition-all ${
            activeTab === 'orders' ? 'text-emerald-400 scale-105' : 'text-slate-400 hover:text-white'
          }`}
        >
          <ShoppingBag className="w-5 h-5" />
          <span>Orders</span>
        </button>

        {/* Account / Fayda Verification Tab */}
        <button
          onClick={onOpenFaydaModal}
          className={`flex flex-col items-center gap-1 text-[10px] font-bold transition-all ${
            faydaStatus === 'verified' ? 'text-emerald-400' : 'text-slate-400 hover:text-white'
          }`}
        >
          <User className="w-5 h-5" />
          <span>Account</span>
        </button>
      </nav>
    </div>
  );
}
