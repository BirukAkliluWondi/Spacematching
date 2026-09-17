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
  Building,
  Users,
  ShoppingBag,
  User,
  Plus,
  Clock,
  ArrowRight,
  ShieldCheck,
  Star,
  PlusCircle,
  Unlock,
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

// Category configuration with circular background colors matching screenshot
const CATEGORIES = [
  {
    id: 'All',
    label: 'All Rooms',
    icon: Home,
    bg: 'bg-[#DCE6FF]',
    textColor: 'text-[#2563EB]',
  },
  {
    id: 'Single Rooms',
    label: 'Single',
    icon: Home,
    bg: 'bg-[#EDE9FE]',
    textColor: 'text-[#7C3AED]',
  },
  {
    id: 'Shared Rooms',
    label: 'Shared',
    icon: Users,
    bg: 'bg-[#FCE7F3]',
    textColor: 'text-[#DB2777]',
  },
  {
    id: 'Studios',
    label: 'Studios',
    icon: Building,
    bg: 'bg-[#FEF3C7]',
    textColor: 'text-[#D97706]',
  },
  {
    id: 'Addis Center',
    label: 'Bole/Center',
    icon: MapPin,
    bg: 'bg-[#DCFCE7]',
    textColor: 'text-[#16A34A]',
  },
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
  const [activeTab, setActiveTab] = useState<'home' | 'wishlist' | 'cart' | 'account'>('home');
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
      list = list.filter(
        (item) =>
          item.amenities.some((a) => a.toLowerCase().includes(catLower)) ||
          item.title.toLowerCase().includes(catLower) ||
          item.description.toLowerCase().includes(catLower) ||
          item.neighborhood.toLowerCase().includes(catLower)
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
  }, [spaces, searchQuery, activeCategory, sortOrder, activeTab, savedIds]);

  const cleanBotUrl = `https://t.me/${botUsername.replace('@', '')}`;

  return (
    <div className="min-h-screen bg-[#F5F5F7] text-slate-900 pb-28 selection:bg-rose-500 selection:text-white">
      {/* Top Header Section */}
      <header className="sticky top-0 z-30 bg-[#F5F5F7]/95 backdrop-blur-md px-4 pt-3 pb-2 space-y-3">
        {/* Top Row: User Avatar & Start Selling Button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#5B67F7] text-white flex items-center justify-center font-bold text-base shadow-sm">
              BA
            </div>
            <div>
              <h1 className="font-extrabold text-sm text-slate-900 leading-tight">
                SpaceMatch
              </h1>
              <p className="text-[11px] text-slate-500">Addis Ababa, Ethiopia</p>
            </div>
          </div>

          <a
            href={cleanBotUrl}
            target="_blank"
            rel="noreferrer"
            className="px-4 py-2 rounded-xl bg-[#800020] hover:bg-[#990011] text-white font-bold text-xs shadow-md transition-all active:scale-95 flex items-center gap-1.5"
          >
            <span>Start Selling</span>
          </a>
        </div>

        {/* Search Bar Input */}
        <div className="relative">
          <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search any product ..."
            className="w-full pl-11 pr-4 py-3 rounded-2xl bg-white border border-slate-200/80 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 shadow-sm transition-all"
          />
        </div>

        {/* Header Title Row: "All Featured" + Sort & Filter Buttons */}
        <div className="flex items-center justify-between pt-1">
          <h2 className="font-bold text-base text-slate-900">All Featured</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                setSortOrder((prev) =>
                  prev === 'newest'
                    ? 'price_asc'
                    : prev === 'price_asc'
                    ? 'price_desc'
                    : 'newest'
                )
              }
              className="px-3 py-1.5 rounded-xl bg-white border border-slate-200/80 text-slate-800 text-xs font-semibold shadow-sm flex items-center gap-1 hover:bg-slate-50 active:scale-95 transition-all"
            >
              <span>Sort</span>
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-600" />
            </button>

            <button
              onClick={() => {
                setActiveCategory('All');
                setSearchQuery('');
              }}
              className="px-3 py-1.5 rounded-xl bg-white border border-slate-200/80 text-slate-800 text-xs font-semibold shadow-sm flex items-center gap-1 hover:bg-slate-50 active:scale-95 transition-all"
            >
              <span>filter</span>
              <Filter className="w-3.5 h-3.5 text-slate-600" />
            </button>
          </div>
        </div>

        {/* Horizontal Category Circular Icon Badges */}
        <div className="flex items-center justify-between gap-2 overflow-x-auto no-scrollbar pt-1 pb-1">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isActive = activeCategory === cat.id;

            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className="flex flex-col items-center gap-1.5 shrink-0 transition-transform active:scale-95"
              >
                <div
                  className={`w-14 h-14 rounded-full flex items-center justify-center transition-all ${cat.bg} ${
                    isActive ? 'ring-2 ring-slate-900 shadow-md scale-105' : ''
                  }`}
                >
                  <Icon className={`w-6 h-6 ${cat.textColor}`} />
                </div>
                <span
                  className={`text-[11px] font-semibold text-center ${
                    isActive ? 'text-slate-900 font-bold' : 'text-slate-600'
                  }`}
                >
                  {cat.label}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content Feed Area */}
      <main className="px-4 pt-2 space-y-4">
        {/* Welcome Banner Card (Light Grey Card) */}
        <div className="rounded-2xl p-4 bg-[#E2E2E6] border border-slate-300/50 shadow-sm flex items-center justify-between relative overflow-hidden">
          <div className="space-y-1.5 max-w-[60%]">
            <h3 className="font-extrabold text-base text-slate-900 leading-tight">
              Welcome to SpaceMatch
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              our room marketplace on Telegram.
            </p>
            <button
              onClick={() => {
                const el = document.getElementById('listings-grid');
                el?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-400 bg-white/70 text-xs font-bold text-slate-800 shadow-sm hover:bg-white transition-all"
            >
              <span>Shop Now</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="w-24 h-24 rounded-2xl bg-gradient-to-tr from-amber-400 to-rose-400 p-1 flex items-center justify-center shadow-inner">
            <Building className="w-12 h-12 text-white" />
          </div>
        </div>

        {/* Deal of the Day / Featured Highlight Banner (Salmon Pink Banner) */}
        <div className="rounded-2xl p-4 bg-[#FFB5B5] border border-rose-300/60 shadow-sm flex items-center justify-between">
          <div className="space-y-1">
            <h3 className="font-extrabold text-base text-slate-900">
              Deal of the day
            </h3>
            <div className="flex items-center gap-1.5 text-xs text-slate-900 font-medium">
              <Clock className="w-4 h-4 text-slate-900 shrink-0" />
              <span>04h 11m 19s remaining</span>
            </div>
          </div>

          <button
            onClick={() => setActiveCategory('All')}
            className="px-3 py-1.5 rounded-full border border-slate-900/30 text-slate-900 text-xs font-bold bg-white/40 hover:bg-white/70 shadow-sm flex items-center gap-1 transition-all"
          >
            <span>View All</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>

        {/* Listings Grid (oGebeya 2-Column Clean Card Layout) */}
        <div id="listings-grid">
          {isLoading ? (
            <div className="grid grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="rounded-2xl bg-white p-3 animate-pulse space-y-3 shadow-sm">
                  <div className="w-full h-36 rounded-xl bg-slate-200" />
                  <div className="h-4 bg-slate-200 rounded w-3/4" />
                  <div className="h-3 bg-slate-200 rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : filteredSpaces.length === 0 ? (
            <div className="py-12 text-center space-y-3 bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
              <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto text-slate-400">
                <Search className="w-6 h-6" />
              </div>
              <p className="text-slate-800 text-sm font-bold">No rooms found matching your search.</p>
              <button
                onClick={() => {
                  setSearchQuery('');
                  setActiveCategory('All');
                }}
                className="px-4 py-2 rounded-xl bg-[#800020] text-white font-bold text-xs shadow-md"
              >
                Reset Search
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
                    className="group bg-white rounded-2xl overflow-hidden border border-slate-200/80 shadow-sm hover:shadow-md transition-all cursor-pointer flex flex-col justify-between"
                  >
                    {/* Image Header with Favorite Heart */}
                    <div className="relative w-full h-36 bg-slate-100 overflow-hidden">
                      <img
                        src={coverImg}
                        alt={space.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src =
                            'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=600&q=80';
                        }}
                      />
                      <button
                        onClick={(e) => toggleSave(e, space.id)}
                        className={`absolute top-2 right-2 p-1.5 rounded-full backdrop-blur-md transition-all ${
                          isSaved
                            ? 'bg-rose-500 text-white shadow-md'
                            : 'bg-white/80 text-slate-600 hover:text-rose-500'
                        }`}
                      >
                        <Heart className={`w-3.5 h-3.5 ${isSaved ? 'fill-current' : ''}`} />
                      </button>
                    </div>

                    {/* Card Information */}
                    <div className="p-3 space-y-1.5">
                      {/* Price Row with Bag/ETB Icon */}
                      <div className="flex items-center gap-1 text-slate-900 font-extrabold text-sm">
                        <span>💰</span>
                        <span>{Number(space.price_per_month).toLocaleString()}</span>
                        <span className="text-[10px] text-slate-500 font-normal">ETB/mo</span>
                      </div>

                      {/* Room Title */}
                      <h3 className="font-bold text-xs text-slate-900 line-clamp-1 leading-tight">
                        {space.title}
                      </h3>

                      {/* Location Tag */}
                      <div className="flex items-center gap-1 text-[11px] text-slate-500">
                        <MapPin className="w-3 h-3 text-rose-500 shrink-0" />
                        <span className="truncate">{space.neighborhood}</span>
                      </div>

                      {/* Ratings / Reviews Row */}
                      <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5">
                        <div className="flex text-amber-400">
                          {[1, 2, 3, 4, 5].map((s) => (
                            <Star key={s} className="w-2.5 h-2.5 fill-current" />
                          ))}
                        </div>
                        <span>(0 reviews)</span>
                      </div>

                      {/* Unlock Contact Button on Card */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectSpace(space.id);
                        }}
                        className="w-full mt-2 py-1.5 px-2 rounded-xl bg-[#800020] hover:bg-[#990011] text-white font-extrabold text-[11px] shadow-sm flex items-center justify-center gap-1 transition-all active:scale-95"
                      >
                        <Unlock className="w-3 h-3 text-white" />
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

      {/* oGebeya Bottom Fixed Navigation Bar */}
      <nav className="fixed bottom-0 w-full max-w-md sm:max-w-lg left-1/2 -translate-x-1/2 z-40 bg-white border-t border-slate-200/80 px-4 py-2 flex items-center justify-around shadow-lg">
        {/* Home Tab */}
        <button
          onClick={() => setActiveTab('home')}
          className={`flex flex-col items-center gap-0.5 text-[10px] font-medium transition-colors ${
            activeTab === 'home' ? 'text-rose-600 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <Home className="w-5 h-5" />
          <span>Home</span>
        </button>

        {/* Wishlist Tab */}
        <button
          onClick={() => setActiveTab('wishlist')}
          className={`flex flex-col items-center gap-0.5 text-[10px] font-medium relative transition-colors ${
            activeTab === 'wishlist' ? 'text-rose-600 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <Heart className="w-5 h-5" />
          <span>Wishlist</span>
          {savedIds.length > 0 && (
            <span className="absolute -top-1 -right-2 w-3.5 h-3.5 rounded-full bg-rose-500 text-white text-[8px] font-bold flex items-center justify-center">
              {savedIds.length}
            </span>
          )}
        </button>

        {/* Center Action Button (Raised Floating Pill) */}
        <a
          href={cleanBotUrl}
          target="_blank"
          rel="noreferrer"
          className="w-12 h-12 rounded-full bg-white border border-slate-200 shadow-lg flex items-center justify-center -mt-6 text-slate-800 hover:scale-105 active:scale-95 transition-transform"
          title="Post Space"
        >
          <Plus className="w-6 h-6 text-slate-800" />
        </a>

        {/* Unlock Contact / Cart Tab */}
        <button
          onClick={() => {
            setActiveTab('cart');
            if (spaces.length > 0) {
              onSelectSpace(spaces[0].id);
            }
          }}
          className={`flex flex-col items-center gap-0.5 text-[10px] font-medium relative transition-colors ${
            activeTab === 'cart' ? 'text-rose-600 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <ShoppingBag className="w-5 h-5" />
          <span>Cart</span>
          <span className="absolute -top-1 -right-1.5 w-3.5 h-3.5 rounded-full bg-[#800020] text-white text-[8px] font-bold flex items-center justify-center">
            1
          </span>
        </button>

        {/* Account / Fayda Verification Tab */}
        <button
          onClick={onOpenFaydaModal}
          className={`flex flex-col items-center gap-0.5 text-[10px] font-medium transition-colors ${
            faydaStatus === 'verified' ? 'text-emerald-600 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <User className="w-5 h-5" />
          <span>Account</span>
        </button>
      </nav>
    </div>
  );
}
