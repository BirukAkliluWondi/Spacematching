'use client';

import React, { useEffect, useState } from 'react';

interface Space {
  id: string;
  title: string;
  description: string;
  price_per_month: number;
  unlock_fee: number;
  neighborhood: string;
  contact_name: string;
  contact_phone: string;
  status: string;
  created_at: string;
  space_images?: { image_path: string }[];
}

interface Stats {
  totalSpaces: number;
  publishedCount: number;
  archivedCount: number;
  ordersCount: number;
  completedOrdersCount: number;
  totalRevenueETB: number;
  usersCount: number;
}

export default function AdminPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'channel' | 'custom' | 'orders'>('channel');
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  // Custom post form state
  const [customText, setCustomText] = useState('');
  const [customPhoto, setCustomPhoto] = useState('');
  const [selectedListingId, setSelectedListingId] = useState('');
  const [postingCustom, setPostingCustom] = useState(false);

  const fetchAdminData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/channel');
      const data = await res.json();
      if (data.success) {
        setStats(data.stats);
        setSpaces(data.spaces);
      }
    } catch (err) {
      console.error('Failed to load admin data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAdminData();
  }, []);

  const handleBroadcast = async (listingId: string) => {
    setActionStatus(`📢 Post to channel in progress for listing: ${listingId}...`);
    try {
      const res = await fetch('/api/admin/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'broadcast', listingId }),
      });
      const data = await res.json();
      if (data.success) {
        setActionStatus(`✅ Post successfully published to Telegram channel!`);
        fetchAdminData();
      } else {
        setActionStatus(`❌ Post failed: ${data.message || data.error}`);
      }
    } catch (err: any) {
      setActionStatus(`❌ Error: ${err.message}`);
    }
  };

  const handleDeletePost = async (listingId: string) => {
    if (!confirm('Are you sure you want to archive this room listing and delete it from the system?')) {
      return;
    }
    setActionStatus(`🗑️ Archiving space listing: ${listingId}...`);
    try {
      const res = await fetch('/api/admin/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_post', listingId }),
      });
      const data = await res.json();
      if (data.success) {
        setActionStatus(`✅ Space archived successfully!`);
        fetchAdminData();
      } else {
        setActionStatus(`❌ Delete failed: ${data.error || data.message}`);
      }
    } catch (err: any) {
      setActionStatus(`❌ Error: ${err.message}`);
    }
  };

  const handleCustomPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customText.trim()) return;

    setPostingCustom(true);
    setActionStatus('📤 Publishing custom post to channel...');

    try {
      const res = await fetch('/api/admin/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'custom_post',
          text: customText,
          photoUrl: customPhoto || undefined,
          listingId: selectedListingId || undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setActionStatus('✅ Custom announcement published to Telegram channel with Order in Bot button!');
        setCustomText('');
        setCustomPhoto('');
        setSelectedListingId('');
      } else {
        setActionStatus(`❌ Custom post failed: ${data.message || data.error}`);
      }
    } catch (err: any) {
      setActionStatus(`❌ Error: ${err.message}`);
    } finally {
      setPostingCustom(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 font-sans pb-16">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center font-bold text-lg">
              👑
            </div>
            <div>
              <h1 className="font-bold text-lg text-white">SpaceMatch Admin Portal</h1>
              <p className="text-xs text-slate-400">ስማርት የቴሌግራም ቻነልና የክፍሎች አስተዳዳሪ</p>
            </div>
          </div>
          <button
            onClick={fetchAdminData}
            className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition flex items-center gap-1.5"
          >
            🔄 Refresh Data
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 pt-6 space-y-6">
        {/* Status Alert Banner */}
        {actionStatus && (
          <div className="p-4 rounded-xl bg-slate-900 border border-emerald-500/30 text-emerald-400 text-sm flex items-center justify-between shadow-lg">
            <span>{actionStatus}</span>
            <button
              onClick={() => setActionStatus(null)}
              className="text-xs text-slate-400 hover:text-white"
            >
              ✕
            </button>
          </div>
        )}

        {/* Overview Analytics Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
            <p className="text-xs text-slate-400 font-medium">Published Rooms</p>
            <p className="text-2xl font-bold text-emerald-400 mt-1">
              {loading ? '...' : stats?.publishedCount || 0}
            </p>
            <span className="text-[10px] text-slate-500">Live in Channel & App</span>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
            <p className="text-xs text-slate-400 font-medium">Completed Orders</p>
            <p className="text-2xl font-bold text-blue-400 mt-1">
              {loading ? '...' : stats?.completedOrdersCount || 0}
            </p>
            <span className="text-[10px] text-slate-500">Unlocked Contact Cards</span>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
            <p className="text-xs text-slate-400 font-medium">Telebirr Revenue</p>
            <p className="text-2xl font-bold text-amber-400 mt-1">
              {loading ? '...' : `${stats?.totalRevenueETB || 0} ETB`}
            </p>
            <span className="text-[10px] text-slate-500">Total Unlock Fees</span>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
            <p className="text-xs text-slate-400 font-medium">Registered Users</p>
            <p className="text-2xl font-bold text-purple-400 mt-1">
              {loading ? '...' : stats?.usersCount || 0}
            </p>
            <span className="text-[10px] text-slate-500">Bot & App Renter Accounts</span>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 gap-6 text-sm font-medium">
          <button
            onClick={() => setActiveTab('channel')}
            className={`pb-3 border-b-2 transition ${
              activeTab === 'channel'
                ? 'border-emerald-500 text-emerald-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            📢 Channel Posts & Listings ({spaces.filter((s) => s.status === 'published').length})
          </button>
          <button
            onClick={() => setActiveTab('custom')}
            className={`pb-3 border-b-2 transition ${
              activeTab === 'custom'
                ? 'border-emerald-500 text-emerald-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            ✍️ Post Directly to Channel
          </button>
        </div>

        {/* TAB 1: CHANNEL POSTS MANAGER */}
        {activeTab === 'channel' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-200">
                Active Channel Listings & Controls
              </h2>
              <span className="text-xs text-slate-400">
                Direct controls to post or delete listings from Telegram channel
              </span>
            </div>

            {loading ? (
              <div className="py-12 text-center text-slate-500">Loading listings...</div>
            ) : spaces.length === 0 ? (
              <div className="py-12 text-center text-slate-500 bg-slate-900/50 rounded-2xl border border-slate-800">
                No room listings found.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {spaces.map((space) => {
                  const coverPhoto =
                    space.space_images && space.space_images.length > 0
                      ? space.space_images[0].image_path
                      : 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=600&q=80';

                  const isPublished = space.status === 'published';

                  return (
                    <div
                      key={space.id}
                      className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col justify-between"
                    >
                      <div className="p-4 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <img
                            src={coverPhoto}
                            alt={space.title}
                            className="w-20 h-20 rounded-xl object-cover border border-slate-800"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                                  isPublished
                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                    : 'bg-slate-800 text-slate-400'
                                }`}
                              >
                                {space.status.toUpperCase()}
                              </span>
                              <span className="text-xs text-slate-400">📍 {space.neighborhood}</span>
                            </div>
                            <h3 className="font-bold text-sm text-slate-100 truncate mt-1">
                              {space.title}
                            </h3>
                            <p className="text-xs text-emerald-400 font-semibold mt-0.5">
                              {Number(space.price_per_month).toLocaleString()} ETB/month • Fee: {space.unlock_fee} ETB
                            </p>
                            <p className="text-xs text-slate-400 mt-1">
                              👤 {space.contact_name} ({space.contact_phone})
                            </p>
                          </div>
                        </div>
                        <p className="text-xs text-slate-400 line-clamp-2">{space.description}</p>
                      </div>

                      <div className="bg-slate-950 p-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                        <button
                          onClick={() => handleBroadcast(space.id)}
                          className="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl transition flex items-center justify-center gap-1.5"
                        >
                          📢 Post to Channel
                        </button>
                        <button
                          onClick={() => handleDeletePost(space.id)}
                          className="py-2 px-3 bg-rose-950/80 hover:bg-rose-950 text-rose-300 border border-rose-800/50 font-medium text-xs rounded-xl transition flex items-center justify-center gap-1.5"
                        >
                          🗑️ Delete Post
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: CUSTOM DIRECT CHANNEL POST BUILDER */}
        {activeTab === 'custom' && (
          <div className="max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Post Custom Announcement to Channel
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Compose a custom text or photo post. The system will automatically attach the{' '}
                <span className="text-emerald-400 font-semibold">"🛒 በቦት እዘዝ (Order in Bot)"</span>{' '}
                inline button to your post in the channel.
              </p>
            </div>

            <form onSubmit={handleCustomPost} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Post Caption / Text (HTML formatted)
                </label>
                <textarea
                  rows={5}
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  placeholder="🏠 አዲስ የሚከራይ ክፍል በቦሌ አትላስ...\n💵 ወርሃዊ ኪራይ፡ 15,000 ብር"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Photo URL (Optional)
                </label>
                <input
                  type="url"
                  value={customPhoto}
                  onChange={(e) => setCustomPhoto(e.target.value)}
                  placeholder="https://images.unsplash.com/photo-1522708323590-d24dbb6b0267"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Link Order Button to Specific Room (Optional)
                </label>
                <select
                  value={selectedListingId}
                  onChange={(e) => setSelectedListingId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="">-- General Order Menu (Default) --</option>
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} ({s.neighborhood}) - {s.price_per_month} ETB
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={postingCustom}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-sm rounded-xl transition flex items-center justify-center gap-2"
              >
                {postingCustom ? 'Publishing...' : '📢 Publish Directly to Telegram Channel'}
              </button>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
